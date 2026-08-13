// ============================================================================
// ENRICH-THOUGHT
// ============================================================================
// This runs automatically a few seconds after any thought is saved, no matter
// where it came from — the web app, Telegram, a YouTube capture, anything.
//
// It does four jobs in order:
//   1. Asks the AI for tags, a category, and a one-line summary
//   2. Generates the "meaning fingerprint" (embedding) used by smart search
//   3. Splits long content into overlapping chunks, each with its own
//      fingerprint, so a detail buried in the middle is still findable
//   4. Finds the thoughts most similar in meaning and links them together
//
// That last step is what builds the graph. Over time your brain grows a web
// of connections without you ever managing it.
//
// DESIGN RULE: this function must never crash and must always return 200.
// It is called by a database webhook, and a failure here would otherwise make
// saving a thought look broken to the user. Every step degrades gracefully:
// no AI means no tags, no embedding means no links, and the thought is still
// safely saved either way.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLMForJSON, generateEmbedding, corsHeaders, jsonResponse } from '../_shared/ai.ts'
import { saveThoughtChunksSafe } from '../_shared/thought-chunks.ts'

// These two are provided automatically by Supabase inside every edge function.
// You do NOT create them yourself — Supabase reserves the SUPABASE_ prefix and
// will reject any secret you try to add with that name.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Very short thoughts ("ok", "todo") aren't worth an AI call.
const MIN_LENGTH_FOR_ENRICHMENT = 20

// How alike two thoughts must be before they get linked. 0.5 was tested
// against a real brain of 1,000+ thoughts: it produced ~1,800 meaningful
// connections — enough to be useful, not so many that everything connects
// to everything.
const LINK_THRESHOLD = 0.5
const MAX_LINKS_PER_THOUGHT = 5

const VALID_CATEGORIES = [
  'idea', 'learning', 'question', 'reference', 'plan', 'reflection', 'digest',
]

interface Enrichment {
  tags?: unknown
  category?: unknown
  summary?: unknown
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    const payload = await req.json()

    // A Supabase database webhook sends { type, table, record, old_record }.
    // We also accept a bare thought object so the function can be re-run by
    // hand on a single row for troubleshooting.
    const record = payload?.record ?? payload
    const thoughtId: string | undefined = record?.id
    const userId: string | undefined = record?.user_id
    const content: string = record?.content ?? ''

    if (!thoughtId || !userId) {
      console.log('[enrich] Missing id or user_id — nothing to do')
      return jsonResponse({ ok: true, skipped: 'missing id or user_id' })
    }

    // Already processed? Database webhooks can fire more than once.
    if (record?.enriched_at) {
      console.log(`[enrich] ${thoughtId} already enriched — skipping`)
      return jsonResponse({ ok: true, skipped: 'already enriched' })
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // ---------------------------------------------------------------------
    // STEP 1 — tags, category, summary
    // ---------------------------------------------------------------------
    let tags: string[] = []
    let category: string | null = null
    let summary: string | null = null

    if (content.length >= MIN_LENGTH_FOR_ENRICHMENT) {
      const enrichment = await callLLMForJSON<Enrichment>({
        systemPrompt:
          'You organise a personal knowledge base. Reply with JSON only — no ' +
          'explanation, no markdown fences.',
        prompt:
          `Analyse this saved thought and return JSON in exactly this shape:\n` +
          `{\n` +
          `  "tags": ["3 to 5 short lowercase topic tags"],\n` +
          `  "category": "one of: ${VALID_CATEGORIES.join(', ')}",\n` +
          `  "summary": "one sentence, max 25 words"\n` +
          `}\n\n` +
          `Thought:\n${content.slice(0, 6000)}`,
        maxTokens: 400,
        userId,
        source: 'enrich-thought',
      })

      if (enrichment) {
        if (Array.isArray(enrichment.tags)) {
          tags = enrichment.tags
            .filter((t): t is string => typeof t === 'string')
            .map(t => t.toLowerCase().trim())
            .filter(Boolean)
            .slice(0, 5)
        }
        if (typeof enrichment.category === 'string') {
          const c = enrichment.category.toLowerCase().trim()
          // Only accept a category from our list — models occasionally invent one
          if (VALID_CATEGORIES.includes(c)) category = c
        }
        if (typeof enrichment.summary === 'string') {
          summary = enrichment.summary.trim().slice(0, 500)
        }
      } else {
        console.log(`[enrich] ${thoughtId}: AI enrichment unavailable, continuing`)
      }
    } else {
      console.log(`[enrich] ${thoughtId}: too short to enrich (${content.length} chars)`)
    }

    // ---------------------------------------------------------------------
    // STEP 2 — the meaning fingerprint
    // ---------------------------------------------------------------------
    const embedding = await generateEmbedding(content, { userId, source: 'enrich-thought' })
    if (!embedding) {
      console.log(`[enrich] ${thoughtId}: no embedding — thought will not be searchable by meaning yet`)
    }

    // Write everything we managed to produce back onto the row.
    const { error: updateError } = await supabase
      .from('thoughts')
      .update({
        tags,
        category,
        summary,
        embedding,
        enriched_at: new Date().toISOString(),
      })
      .eq('id', thoughtId)

    if (updateError) {
      console.error(`[enrich] ${thoughtId}: update failed:`, updateError.message)
      // Still return 200 — see the design rule at the top of this file.
      return jsonResponse({ ok: false, error: updateError.message })
    }

    // ---------------------------------------------------------------------
    // STEP 2.5 — chunk the content, for thoughts long enough that one vector
    // over the whole thing would bury a detail buried mid-document. Short
    // thoughts (most voice notes, most Telegram messages) are under the
    // chunker's minimum and this is a no-op for them.
    // ---------------------------------------------------------------------
    const chunksWritten = await saveThoughtChunksSafe(supabase, thoughtId, content, 'enrich-thought', 'summary', userId)

    // ---------------------------------------------------------------------
    // STEP 3 — build the graph
    // ---------------------------------------------------------------------
    let linksCreated = 0

    if (embedding) {
      const { data: neighbours, error: rpcError } = await supabase.rpc(
        'find_links_for_thought',
        {
          p_user_id: userId,
          source_id: thoughtId,
          source_embedding: embedding,
          match_threshold: LINK_THRESHOLD,
          match_count: MAX_LINKS_PER_THOUGHT,
        }
      )

      if (rpcError) {
        console.error(`[enrich] ${thoughtId}: neighbour lookup failed:`, rpcError.message)
      } else if (Array.isArray(neighbours) && neighbours.length > 0) {
        const links = neighbours.map((n: { target_id: string; similarity: number }) => ({
          user_id: userId,
          source_thought_id: thoughtId,
          target_thought_id: n.target_id,
          similarity_score: n.similarity,
          link_type: 'semantic',
        }))

        // ignoreDuplicates: if this pair is already linked (in either
        // direction — the database enforces that), skip it silently.
        const { error: linkError } = await supabase
          .from('thought_links')
          .upsert(links, {
            onConflict: 'source_thought_id,target_thought_id',
            ignoreDuplicates: true,
          })

        if (linkError) {
          console.error(`[enrich] ${thoughtId}: saving links failed:`, linkError.message)
        } else {
          linksCreated = links.length
        }
      }
    }

    console.log(
      `[enrich] ${thoughtId}: done — ${tags.length} tags, ` +
      `category=${category ?? 'none'}, embedding=${embedding ? 'yes' : 'no'}, ` +
      `chunks=${chunksWritten}, links=${linksCreated}`
    )

    return jsonResponse({
      ok: true,
      thought_id: thoughtId,
      tags,
      category,
      summary,
      embedded: Boolean(embedding),
      chunks_created: chunksWritten,
      links_created: linksCreated,
    })

  } catch (err) {
    // Catch-all. Log loudly, return 200 so the webhook is not retried forever.
    console.error('[enrich] Unexpected failure:', String(err))
    return jsonResponse({ ok: false, error: String(err) })
  }
})
