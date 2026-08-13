// ============================================================================
// BACKFILL-BRAIN
// ============================================================================
// One-time admin tool for upgrading a brain that already has thoughts in it.
// The schema upgrade (migration.sql) creates the new tables and columns, but
// it cannot fill them in for thoughts that already exist — that is what this
// does. Without it, a brain that upgrades still finds a buried detail no
// better than before: the new capabilities only apply to things captured
// AFTER the upgrade.
//
// Called repeatedly by Claude Code during the upgrade (see UPGRADE.md), not by
// the app. Nothing here is on a schedule and nothing calls it automatically.
//
// THREE JOBS, IN PRIORITY ORDER, ONE BATCH EACH PER CALL:
//   1. Document-level embeddings for thoughts that have none. Without this,
//      old thoughts cannot be found by meaning at all — only by exact keyword.
//   2. Chunks for thoughts long enough to need them, so a detail buried in the
//      middle of an old long capture becomes findable, exactly like a new one.
//   3. (Optional, opt-in) Re-fetching the original web page for old url
//      captures that never had their full source text stored, so it can be
//      chunked and searched too. Best-effort: the page may have changed,
//      moved, or gone entirely since it was first captured. A failure here is
//      logged and skipped, never fatal.
//
// RESUMABLE AND IDEMPOTENT: each job is driven by a WHERE clause ("embedding
// IS NULL", "no chunks yet", "no source yet") rather than a job table, so
// there is nothing to get out of sync. Call this again and it simply picks up
// wherever the WHERE clause says work remains — dying mid-batch, running it
// twice, or running it a week later all behave the same way. A batch that
// already ran leaves nothing left for the next call to redo.
//
// TIME-BOUNDED: stops starting new work well before Supabase's edge worker
// timeout so an in-flight item can finish and the response still gets
// written, instead of the whole call being killed with no result at all.
//
// POST /backfill-brain
//   { dry_run?: boolean, batch_size?: number, recover_url_sources?: boolean }
//
//   dry_run: true       — count remaining work and estimate embedding cost.
//                          Does not write anything. Call this FIRST, show the
//                          person the number, and only proceed once they say
//                          go — it is their API key and their money.
//   batch_size          — default 20, max 50, per job per call.
//   recover_url_sources — default false. When true, also attempts job 3.
//
// Response:
//   { ok, embeddings: {done,remaining}, chunks: {done,remaining},
//     url_sources: {done,remaining,failed}, stopped_early, elapsed_ms }
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateEmbedding, corsHeaders, jsonResponse } from '../_shared/ai.ts'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'
import { saveThoughtSourceSafe } from '../_shared/thought-sources.ts'
import { htmlToText } from '../_shared/html-extract.ts'
import { shouldChunk } from '../_shared/chunking.ts'

/**
 * Which of these candidate thought ids do NOT already have a thought_sources row.
 * Two plain queries and a JS diff, rather than a PostgREST embedded-resource anti-join —
 * easier to read, and does not depend on how supabase-js happens to shape a reverse
 * one-to-one embed (array vs object vs null) across versions.
 */
async function withoutSource(supabase: any, thoughtIds: string[]): Promise<Set<string>> {
  if (thoughtIds.length === 0) return new Set()
  const { data } = await supabase.from('thought_sources').select('thought_id').in('thought_id', thoughtIds)
  const have = new Set((data ?? []).map((r: any) => r.thought_id))
  return new Set(thoughtIds.filter((id) => !have.has(id)))
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Supabase edge workers are cut off around 150s. Stop starting new items well
// before that so the in-flight one can finish and the response still writes.
const TIME_BUDGET_MS = 100_000

// text-embedding-3-small: roughly $0.02 per 1M tokens, roughly 4 characters
// per token. This is an ESTIMATE for the person to look at before spending
// anything real — not a quote. Actual cost is shown afterwards in the app,
// from real numbers in llm_usage, same as every other AI call here.
const EST_USD_PER_CHAR = 0.02 / 1_000_000 / 4

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })
  if (req.method !== 'POST') return jsonResponse({ ok: false, error: 'Method not allowed' }, 405)

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const startedAt = Date.now()

  let batchSize = 20
  let dryRun = false
  let recoverUrlSources = false
  try {
    const body = await req.json()
    if (typeof body?.batch_size === 'number' && body.batch_size > 0) {
      batchSize = Math.min(Math.floor(body.batch_size), 50)
    }
    if (body?.dry_run === true) dryRun = true
    if (body?.recover_url_sources === true) recoverUrlSources = true
  } catch { /* body is optional */ }

  // ---------------------------------------------------------------------
  // DRY RUN — count only, spend nothing, write nothing.
  // ---------------------------------------------------------------------
  if (dryRun) {
    const { count: needEmbedding } = await supabase
      .from('thoughts').select('id', { count: 'exact', head: true }).is('embedding', null)

    const { data: charRows } = await supabase
      .from('thoughts').select('content').is('embedding', null)
    const totalChars = (charRows ?? []).reduce((sum, r) => sum + (r.content?.length ?? 0), 0)
    const estimatedUsd = totalChars * EST_USD_PER_CHAR

    const { count: needChunks } = await supabase
      .from('thoughts_needing_chunks').select('id', { count: 'exact', head: true })

    let recoverableUrlSources: number | null = null
    if (recoverUrlSources) {
      const { data: candidates } = await supabase
        .from('thoughts').select('id').not('metadata->>url', 'is', null)
      const missing = await withoutSource(supabase, (candidates ?? []).map((r: any) => r.id))
      recoverableUrlSources = missing.size
    }

    return jsonResponse({
      ok: true,
      dry_run: true,
      needs_embedding: needEmbedding ?? 0,
      needs_chunks: needChunks ?? 0,
      recoverable_url_sources: recoverableUrlSources,
      estimated_cost_usd: Math.round(estimatedUsd * 10000) / 10000,
      note:
        'This is an estimate, not a quote. The app shows the real amount spent, ' +
        'the same way it does for every other AI call.',
    })
  }

  // ---------------------------------------------------------------------
  // JOB 1 — document-level embeddings for thoughts that have none.
  // ---------------------------------------------------------------------
  const embeddings = { done: 0, remaining: 0 }
  {
    const { data: rows } = await supabase
      .from('thoughts').select('id, content')
      .is('embedding', null)
      .order('created_at', { ascending: true })
      .limit(batchSize)

    for (const row of rows ?? []) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      if (!row.content?.trim()) continue
      const embedding = await generateEmbedding(row.content, { source: 'backfill-brain:embedding' })
      if (!embedding) continue // AI unavailable this call — next call tries again, nothing lost
      const { error } = await supabase.from('thoughts').update({ embedding }).eq('id', row.id)
      if (!error) embeddings.done++
    }

    const { count } = await supabase
      .from('thoughts').select('id', { count: 'exact', head: true }).is('embedding', null)
    embeddings.remaining = count ?? 0
  }

  // ---------------------------------------------------------------------
  // JOB 2 — chunks for thoughts long enough to need them.
  // thoughts_needing_chunks (from migration.sql) already excludes anything
  // chunked, so re-running this after a partial sweep just continues.
  // ---------------------------------------------------------------------
  const chunks = { done: 0, remaining: 0 }
  {
    const { data: rows } = await supabase
      .from('thoughts_needing_chunks').select('id, chars')
      .order('chars', { ascending: false }) // biggest documents first: most value if interrupted
      .limit(batchSize)

    for (const row of rows ?? []) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      const { data: full } = await supabase.from('thoughts').select('content').eq('id', row.id).single()
      if (!full?.content || !shouldChunk(full.content)) continue
      const written = await saveThoughtChunksSafe(supabase, row.id, full.content, 'backfill-brain', 'summary')
      if (written > 0) chunks.done++
    }

    const { count } = await supabase
      .from('thoughts_needing_chunks').select('id', { count: 'exact', head: true })
    chunks.remaining = count ?? 0
  }

  // ---------------------------------------------------------------------
  // JOB 3 — (opt-in) re-fetch old url captures that never had source text
  // stored, so the full article becomes chunked and searchable too.
  //
  // BEST-EFFORT AND HONEST: this re-fetches the URL AS IT IS TODAY. If the
  // page changed since the original capture, the recovered text will not be
  // exactly what was summarised back then — it will be whatever is there
  // now. If the page is gone, paywalled, or blocks automated readers, this
  // fails for that one row and moves on. There is no way to recover text
  // that nobody ever stored; this is the best available substitute, not a
  // guarantee.
  // ---------------------------------------------------------------------
  const urlSources = { done: 0, remaining: 0, failed: 0 }
  if (recoverUrlSources) {
    // Over-fetch candidates (metadata->>url present) then narrow to the ones missing a
    // source row — cheaper than it sounds: this table is thoughts, not thought_chunks, so
    // even a whole brain's worth of url captures is a small query.
    const { data: candidates } = await supabase
      .from('thoughts').select('id, metadata').not('metadata->>url', 'is', null)
    const missingIds = await withoutSource(supabase, (candidates ?? []).map((r: any) => r.id))
    const pending = (candidates ?? []).filter((r: any) => missingIds.has(r.id)).slice(0, batchSize)

    for (const row of pending) {
      if (Date.now() - startedAt > TIME_BUDGET_MS) break
      const url = (row as any).metadata?.url
      if (!url) continue
      try {
        const pageRes = await fetch(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
              '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(20_000),
        })
        if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`)
        const raw = await pageRes.text()
        const { text } = htmlToText(raw)
        if (text.length < 200) throw new Error('almost no readable text found')

        const result = await saveThoughtSourceSafe(supabase, row.id, text, 'web', 'backfill-brain')
        if (result.stored) urlSources.done++
        else urlSources.failed++
      } catch (err) {
        urlSources.failed++
        console.log(`[backfill-brain] could not recover ${url}: ${String(err)}`)
      }
    }

    const { data: stillCandidates } = await supabase
      .from('thoughts').select('id').not('metadata->>url', 'is', null)
    const stillMissing = await withoutSource(supabase, (stillCandidates ?? []).map((r: any) => r.id))
    urlSources.remaining = stillMissing.size
  }

  return jsonResponse({
    ok: true,
    embeddings,
    chunks,
    url_sources: recoverUrlSources ? urlSources : null,
    stopped_early: Date.now() - startedAt > TIME_BUDGET_MS,
    elapsed_ms: Date.now() - startedAt,
  })
})
