// ============================================================================
// CAPTURE-YOUTUBE
// ============================================================================
// Paste a YouTube link, get the spoken transcript summarised into your brain.
//
// WHY THIS FILE IS COMPLICATED — worth understanding before changing anything:
//
// YouTube serves a stripped-down page with no captions when the request comes
// from a datacentre — which is exactly what a Supabase edge function is. Code
// that works perfectly on your laptop fails once deployed. That is not a bug
// in your code, it is YouTube treating servers differently from people.
//
// So we try several routes and take the first that works:
//
//   1. SUPADATA   — a service built for this. Fetches from residential IPs, so
//                   it gets real transcripts. Free tier covers ~100/month.
//                   Optional: if you have no key we skip straight to step 2.
//   2. INNERTUBE  — YouTube's own internal app API. We identify as the iPhone
//                   and Android apps, which YouTube serves properly even from
//                   a datacentre. No key needed, free, works often.
//   3. DESCRIPTION — if no captions exist anywhere (or the video has none at
//                   all), fall back to the title and description so you still
//                   capture something useful. Clearly labelled as such.
//
// The result is summarised by the AI and saved. The enrich-thought function
// then tags it and links it into your graph automatically.
// ============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { callLLM, corsHeaders, jsonResponse } from '../_shared/ai.ts'
import { decodeEntities } from '../_shared/text.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'
import { saveThoughtSourceSafe } from '../_shared/thought-sources.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPADATA_KEY = Deno.env.get('SUPADATA_API_KEY') ?? ''   // optional

interface VideoContent {
  content: string
  hasTranscript: boolean
  source: string
}

// ---------------------------------------------------------------------------
// Pull the 11-character video id out of any YouTube URL shape
// ---------------------------------------------------------------------------
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ]
  for (const p of patterns) {
    const m = url.match(p)
    if (m) return m[1]
  }
  return null
}

// ---------------------------------------------------------------------------
// Title via oEmbed — lightweight, no key, essentially always works
// ---------------------------------------------------------------------------
async function fetchTitle(videoUrl: string, videoId: string): Promise<string> {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (res.ok) {
      const data = await res.json()
      if (data?.title) return data.title as string
    }
  } catch { /* fall through to placeholder */ }
  return `Video ${videoId}`
}

// ---------------------------------------------------------------------------
// ROUTE 1 — Supadata
// ---------------------------------------------------------------------------
async function fromSupadata(videoUrl: string): Promise<VideoContent | null> {
  if (!SUPADATA_KEY) return null

  try {
    const res = await fetch(
      `https://api.supadata.ai/v1/youtube/transcript?url=${encodeURIComponent(videoUrl)}&lang=en`,
      { headers: { 'x-api-key': SUPADATA_KEY }, signal: AbortSignal.timeout(20_000) }
    )
    if (!res.ok) {
      // 402 here almost always means the free monthly quota is spent
      console.log(`[youtube] Supadata HTTP ${res.status} — falling through`)
      return null
    }

    const data = await res.json()
    const segments: Array<{ text?: string }> = data?.content ?? []
    const transcript = segments
      .map(s => s.text ?? '')
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()

    if (!transcript) return null
    console.log(`[youtube] Supadata OK — ${transcript.length} chars`)
    return { content: transcript, hasTranscript: true, source: 'supadata' }
  } catch (err) {
    console.error('[youtube] Supadata error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// ROUTE 2 — Innertube (YouTube's internal app API)
//
// We pose as the iPhone app first, then Android. YouTube hands mobile apps a
// full caption list with signed URLs even from a datacentre, where the normal
// web page would give us nothing.
// ---------------------------------------------------------------------------
async function fromInnertube(videoId: string): Promise<VideoContent | null> {
  const clients = [
    {
      name: 'IOS',
      userAgent: 'com.google.ios.youtube/19.29.1 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      context: {
        clientName: 'IOS', clientVersion: '19.29.1',
        deviceMake: 'Apple', deviceModel: 'iPhone17,2',
        osName: 'iPhone', osVersion: '18.1.0.22B83', hl: 'en', gl: 'US',
      },
    },
    {
      name: 'ANDROID',
      userAgent: 'com.google.android.youtube/20.10.38 (Linux; U; Android 14)',
      context: {
        clientName: 'ANDROID', clientVersion: '20.10.38', hl: 'en', gl: 'US',
      },
    },
  ]

  let best: Record<string, unknown> | null = null

  for (const client of clients) {
    try {
      const res = await fetch(
        'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': client.userAgent },
          body: JSON.stringify({ context: { client: client.context }, videoId }),
          signal: AbortSignal.timeout(15_000),
        }
      )
      if (!res.ok) {
        console.log(`[youtube] Innertube ${client.name} HTTP ${res.status}`)
        continue
      }

      const result = await res.json()
      const tracks = result?.captions?.playerCaptionsTracklistRenderer?.captionTracks

      if (Array.isArray(tracks) && tracks.length > 0) {
        console.log(`[youtube] Innertube ${client.name}: ${tracks.length} caption tracks`)
        best = result
        break
      }
      // Keep the first response around — even without captions it carries the
      // description, which is better than nothing.
      if (!best) best = result
      console.log(`[youtube] Innertube ${client.name}: no caption tracks`)
    } catch (err) {
      console.error(`[youtube] Innertube ${client.name} error:`, String(err))
    }
  }

  if (!best) return null

  try {
    const tracks = (best as any)?.captions?.playerCaptionsTracklistRenderer?.captionTracks

    if (Array.isArray(tracks) && tracks.length > 0) {
      // Prefer human-written English, then auto-generated English, then anything
      const track =
        tracks.find((t: any) => t.languageCode === 'en' && t.kind !== 'asr') ??
        tracks.find((t: any) => t.languageCode === 'en') ??
        tracks.find((t: any) => String(t.languageCode ?? '').startsWith('en')) ??
        tracks[0]

      const capRes = await fetch(track.baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
        signal: AbortSignal.timeout(12_000),
      })

      if (capRes.ok) {
        const xml = await capRes.text()
        // Caption XML looks like: <text start="1.2" dur="3.4">words here</text>
        const transcript = [...xml.matchAll(/<text[^>]*>([^<]*)<\/text>/g)]
          .map(m => decodeEntities(m[1]))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()

        if (transcript) {
          console.log(`[youtube] Innertube transcript OK — ${transcript.length} chars`)
          return { content: transcript, hasTranscript: true, source: 'innertube' }
        }
      }
    }

    // ROUTE 3 — no captions anywhere. Use the description.
    const details = (best as any)?.videoDetails
    const description: string = details?.shortDescription ?? ''
    const keywords: string = (details?.keywords as string[] | undefined)?.join(', ') ?? ''

    if (description || keywords) {
      const content = [description, keywords ? `Keywords: ${keywords}` : '']
        .filter(Boolean).join('\n\n')
      console.log(`[youtube] Falling back to description — ${description.length} chars`)
      return { content, hasTranscript: false, source: 'description' }
    }

    return null
  } catch (err) {
    console.error('[youtube] Innertube parse error:', String(err))
    return null
  }
}

// ---------------------------------------------------------------------------
// Summarise into something worth keeping
// ---------------------------------------------------------------------------
async function summarise(
  title: string,
  content: string,
  hasTranscript: boolean,
  userId?: string
): Promise<string> {
  const label = hasTranscript ? 'Transcript' : 'Video description'
  const caveat = hasTranscript
    ? ''
    : '\n\nIMPORTANT: no captions were available for this video, so you are ' +
      'working from the description only. Begin your summary with ' +
      '"(Based on the video description — no transcript was available)".'

  const summary = await callLLM({
    systemPrompt: 'You summarise video content for a personal knowledge base. Be concrete and specific.',
    prompt:
      `Summarise this video for someone who wants to remember what it taught them.\n\n` +
      `Cover: the main topic, the key insights, and any actionable takeaways.\n` +
      `Write 3 to 5 short paragraphs. No preamble, no "this video discusses" — ` +
      `just the substance.${caveat}\n\n` +
      `Video title: "${title}"\n\n${label}:\n${content.slice(0, 12_000)}`,
    maxTokens: 1200,
    userId,
    source: 'capture-youtube',
  })

  if (summary) return `📹 ${title}\n\n${summary}`

  // AI unavailable — keep the raw material rather than losing the capture
  console.log('[youtube] Summarisation unavailable — saving raw excerpt')
  return `📹 ${title}\n\n${content.slice(0, 4000)}`
}

// ---------------------------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  try {
    // Identify the caller from their login token. We never trust a user id
    // sent in the request body — that would let anyone write into anyone
    // else's brain.
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
      return jsonResponse({ ok: false, error: 'A YouTube url is required' }, 400)
    }

    const videoId = extractVideoId(url)
    if (!videoId) {
      return jsonResponse({
        ok: false,
        error: 'That does not look like a YouTube link. Expected something like https://www.youtube.com/watch?v=...',
      }, 400)
    }

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`
    const title = await fetchTitle(videoUrl, videoId)

    // Try each route in order, first success wins
    const result =
      (await fromSupadata(videoUrl)) ??
      (await fromInnertube(videoId))

    if (!result) {
      return jsonResponse({
        ok: false,
        error:
          'Could not read anything from that video. It may be private, ' +
          'age-restricted, or region-locked. Try a different one.',
      }, 422)
    }

    const summary = await summarise(title, result.content, result.hasTranscript, user.id)

    // Save it. The enrich-thought webhook will pick this up within seconds and
    // add tags, a category, the meaning fingerprint, and graph links.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
    const saved = await saveThoughtRow(admin, {
      user_id: user.id,
      content: summary,
      source: 'youtube',
      metadata: {
        title,
        video_id: videoId,
        video_url: videoUrl,
        has_transcript: result.hasTranscript,
        fetched_via: result.source,
      },
    })

    // Keep the full transcript (or description) too, chunked separately, so a detail the
    // summary dropped is still searchable. Labelled by kind so it is clear later which one
    // a given source came from.
    const src = await saveThoughtSourceSafe(
      admin,
      saved.id,
      result.content,
      result.hasTranscript ? 'youtube_transcript' : 'youtube_description',
      'capture-youtube',
      user.id,
    )

    return jsonResponse({
      ok: true,
      title,
      has_transcript: result.hasTranscript,
      fetched_via: result.source,
      deduped: saved.deduped,
      source_chunks: src.chunks,
      preview: summary.slice(0, 240) + '…',
    })

  } catch (err) {
    console.error('[youtube] Failed:', String(err))
    return jsonResponse({ ok: false, error: String(err) }, 500)
  }
})
