// ============================================================================
// CAPTURE-URL
// ============================================================================
// Paste any article or web page link and the readable text gets pulled out,
// summarised, and saved.
//
// WHY THIS RUNS ON THE SERVER: a web browser is not allowed to fetch pages
// from other websites — that restriction is called CORS and it exists for good
// security reasons. But a server has no such limit. So the browser hands the
// link to this function, and this function does the fetching.
//
// (The original course told people to copy and paste article text by hand
// because of the browser limitation. That was solving the problem in the wrong
// place — the server was always available.)
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM, corsHeaders, jsonResponse } from '../_shared/ai.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'
import { saveThoughtSourceSafe } from '../_shared/thought-sources.ts'
import { htmlToText } from '../_shared/html-extract.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!

const MAX_BYTES = 3_000_000   // don't try to swallow a 50MB page

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Who is asking? Taken from their login token, never from the request body.
    const authHeader = req.headers.get('Authorization') ?? ''
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return jsonResponse({ ok: false, error: 'Not signed in' }, 401)
    }

    const { url } = await req.json()
    if (!url || typeof url !== 'string') {
      return jsonResponse({ ok: false, error: 'A url is required' }, 400)
    }

    // Only http(s). Blocks attempts to make the server read internal addresses.
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return jsonResponse({ ok: false, error: 'That is not a valid web address' }, 400)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonResponse({ ok: false, error: 'Only http and https links are supported' }, 400)
    }

    // Fetch the page, identifying as a normal browser — some sites refuse
    // anything that looks automated.
    const pageRes = await fetch(parsed.toString(), {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(20_000),
    })

    if (!pageRes.ok) {
      return jsonResponse({
        ok: false,
        error: `That page returned an error (HTTP ${pageRes.status}). It may require a login or block automated readers.`,
      }, 422)
    }

    const contentType = pageRes.headers.get('content-type') ?? ''
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return jsonResponse({
        ok: false,
        error: `That link is a ${contentType.split(';')[0] || 'file'}, not a web page. For PDFs, use the PDF tab instead.`,
      }, 415)
    }

    const raw = await pageRes.text()
    if (raw.length > MAX_BYTES) {
      return jsonResponse({ ok: false, error: 'That page is too large to process' }, 413)
    }

    const { title, text } = htmlToText(raw)

    if (text.length < 200) {
      return jsonResponse({
        ok: false,
        error:
          'Almost no readable text was found. The page probably builds itself ' +
          'with JavaScript after loading, which a server cannot see. Try ' +
          'copying the text in manually with the Text tab.',
      }, 422)
    }

    // Summarise
    const summary = await callLLM({
      systemPrompt: 'You summarise articles for a personal knowledge base. Be concrete and specific.',
      prompt:
        `Summarise this article for someone who wants to remember what it said.\n` +
        `Cover the main argument, the key points, and anything worth acting on.\n` +
        `Write 3 to 5 short paragraphs. No preamble.\n\n` +
        `Title: "${title}"\nSource: ${parsed.hostname}\n\n${text.slice(0, 14_000)}`,
      maxTokens: 1200,
      userId: user.id,
      source: 'capture-url',
    })

    const content = summary
      ? `🔗 ${title}\n${parsed.hostname}\n\n${summary}`
      : `🔗 ${title}\n${parsed.hostname}\n\n${text.slice(0, 4000)}`

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const saved = await saveThoughtRow(admin, {
      user_id: user.id,
      content,
      source: 'url',
      metadata: { title, url: parsed.toString(), hostname: parsed.hostname },
    })

    // The AI summary only ever saw the first 14,000 characters. Keep the full extracted article
    // text too, chunked separately, so a detail past that point is still searchable.
    const src = await saveThoughtSourceSafe(admin, saved.id, text, 'web', 'capture-url', user.id)

    return jsonResponse({
      ok: true,
      title,
      hostname: parsed.hostname,
      summarised: Boolean(summary),
      deduped: saved.deduped,
      source_chunks: src.chunks,
      preview: content.slice(0, 240) + '…',
    })

  } catch (err) {
    console.error('[url] Failed:', String(err))
    const msg = String(err).includes('timeout')
      ? 'That page took too long to respond.'
      : String(err)
    return jsonResponse({ ok: false, error: msg }, 500)
  }
})
