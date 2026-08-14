// ============================================================================
// SHARED AI HELPERS
// ============================================================================
// Every AI call in Open Brain goes through this one file — both the "thinking"
// calls (summarising, tagging) and the "meaning fingerprint" calls (embeddings).
//
// WHY ONE FILE:
//   1. To switch AI providers you edit here and nowhere else.
//   2. It is imported directly by the other functions rather than being its own
//      deployed service. That matters: a function calling another function over
//      HTTP needs authentication headers, which is a classic source of silent
//      401 failures. Importing a module skips that problem entirely.
//
// TO CHANGE MODELS: edit the three constants below. Nothing else changes.
// ============================================================================

const OPENROUTER_KEY = Deno.env.get('OPENROUTER_API_KEY') ?? ''

// ---------------------------------------------------------------------------
// MODEL CHOICES — the only place these are named.
//
// CHAT_MODEL does the tagging and summarising. It runs on every save, so it
// should be cheap and fast. A small model is the right call here.
//
// EMBEDDING_MODEL turns text into 1536 numbers representing its meaning.
// IMPORTANT: if you change this, the new model MUST also output 1536 numbers,
// or the database column will reject it and you will need a new migration.
// ---------------------------------------------------------------------------
const CHAT_MODEL = Deno.env.get('LLM_MODEL') ?? 'anthropic/claude-haiku-4.5'
const EMBEDDING_MODEL = Deno.env.get('EMBEDDING_MODEL') ?? 'openai/text-embedding-3-small'
const EMBEDDING_DIMENSIONS = 1536

// TRANSCRIPTION_MODEL turns spoken audio into text (voice notes from Telegram).
// Whisper-class models are priced per second of audio and auto-detect the
// spoken language, which matters here — do not swap in a model that requires
// a language to be named up front, or Spanish audio silently gets treated as
// English-ish noise.
const TRANSCRIPTION_MODEL = Deno.env.get('TRANSCRIPTION_MODEL') ?? 'openai/whisper-1'

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions'
const OPENROUTER_EMBED_URL = 'https://openrouter.ai/api/v1/embeddings'
const OPENROUTER_TRANSCRIBE_URL = 'https://openrouter.ai/api/v1/audio/transcriptions'


// ---------------------------------------------------------------------------
// CORS headers — lets your web app talk to these functions from a browser.
// ---------------------------------------------------------------------------
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}


// ---------------------------------------------------------------------------
// COST LOGGING
//
// Records what each AI call cost, so the app can show a real number instead of
// an estimate.
//
// SAFETY RULE: this must never affect anything. It is fired without being
// awaited and every failure is swallowed. If the logging breaks, or the table
// does not exist, or the network hiccups, the capture that triggered it still
// succeeds and the user never sees a thing. Cost visibility is a nice-to-have;
// saving the thought is not.
// ---------------------------------------------------------------------------
function logUsage(entry: {
  userId?: string
  kind: 'chat' | 'embedding' | 'transcription'
  model: string
  source?: string
  promptTokens?: number
  completionTokens?: number
  costUsd?: number
}): void {
  if (!entry.userId) return   // nothing to attribute it to

  const url = Deno.env.get('SUPABASE_URL')
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!url || !key) return

  const work = fetch(`${url}/rest/v1/llm_usage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({
      user_id: entry.userId,
      kind: entry.kind,
      model: entry.model,
      source: entry.source ?? null,
      prompt_tokens: entry.promptTokens ?? 0,
      completion_tokens: entry.completionTokens ?? 0,
      cost_usd: entry.costUsd ?? 0,
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => { /* deliberately ignored — see safety rule above */ })

  // Keep the isolate alive until this finishes.
  //
  // Without this, the write is a race: the function returns its response, the
  // runtime tears the isolate down, and an un-awaited fetch that had not yet
  // completed is simply killed. Cost records would land sometimes and vanish
  // other times with no pattern, which is worse than not having them.
  //
  // waitUntil says "I have returned, but do not shut me down yet." We still
  // never await it, so the user's response is not delayed by a single
  // millisecond. The try/catch is for local or older runtimes where
  // EdgeRuntime does not exist — there the plain promise above is the best
  // available, and a missing cost row is an acceptable loss.
  try {
    // @ts-ignore — EdgeRuntime is provided by Supabase, not by Deno itself
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(work)
    }
  } catch { /* not available here — carry on */ }
}


// ---------------------------------------------------------------------------
// callLLM — ask the AI a question, get text back.
//
// Returns null instead of throwing when something goes wrong. Callers should
// carry on without the AI rather than failing the whole save. A thought saved
// without tags is far better than a thought that never saved.
// ---------------------------------------------------------------------------
export async function callLLM(opts: {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
  timeoutMs?: number
  userId?: string      // who to bill this to, for the cost display
  source?: string      // which function spent it
}): Promise<string | null> {
  if (!OPENROUTER_KEY) {
    console.error('[ai] OPENROUTER_API_KEY is not set — skipping LLM call')
    return null
  }

  const messages: Array<{ role: string; content: string }> = []
  if (opts.systemPrompt) messages.push({ role: 'system', content: opts.systemPrompt })
  messages.push({ role: 'user', content: opts.prompt })

  try {
    const res = await fetch(OPENROUTER_CHAT_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: CHAT_MODEL,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        // Asks OpenRouter to report what this call actually cost, rather than
        // us guessing from a price list that goes stale.
        usage: { include: true },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[ai] LLM HTTP ${res.status}: ${errText.slice(0, 300)}`)
      return null
    }

    const data = await res.json()
    const text = data?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) {
      console.error('[ai] LLM returned no usable text')
      return null
    }

    logUsage({
      userId: opts.userId,
      kind: 'chat',
      model: CHAT_MODEL,
      source: opts.source,
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      completionTokens: data?.usage?.completion_tokens ?? 0,
      costUsd: Number(data?.usage?.cost ?? 0),
    })

    return text.trim()
  } catch (err) {
    console.error('[ai] LLM call failed:', String(err))
    return null
  }
}


// ---------------------------------------------------------------------------
// callLLMForJSON — same as above, but insists on a JSON object back.
//
// Models sometimes wrap JSON in explanation or markdown fences. This digs the
// object out rather than giving up, because a parse failure here would mean a
// thought never gets tagged.
// ---------------------------------------------------------------------------
export async function callLLMForJSON<T = Record<string, unknown>>(opts: {
  prompt: string
  systemPrompt?: string
  maxTokens?: number
  userId?: string
  source?: string
}): Promise<T | null> {
  const raw = await callLLM(opts)
  if (!raw) return null

  // Straight parse first
  try {
    return JSON.parse(raw) as T
  } catch { /* fall through */ }

  // Strip ```json fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim()) as T
    } catch { /* fall through */ }
  }

  // Last resort: grab the outermost { ... }
  const braced = raw.match(/\{[\s\S]*\}/)
  if (braced) {
    try {
      return JSON.parse(braced[0]) as T
    } catch { /* fall through */ }
  }

  console.error('[ai] Could not parse JSON from LLM. First 300 chars:', raw.slice(0, 300))
  return null
}


// ---------------------------------------------------------------------------
// generateEmbedding — turn text into its meaning fingerprint.
//
// Returns null on any failure. The caller saves the thought anyway; it simply
// will not be searchable by meaning or linked into the graph until an
// embedding exists.
//
// Long text is trimmed first. Embedding models have an input limit, and the
// first few thousand characters carry the gist well enough for search.
// ---------------------------------------------------------------------------
export async function generateEmbedding(
  text: string,
  attribution?: { userId?: string; source?: string }
): Promise<number[] | null> {
  if (!OPENROUTER_KEY) {
    console.error('[ai] OPENROUTER_API_KEY is not set — skipping embedding')
    return null
  }

  const input = text.replace(/\s+/g, ' ').trim().slice(0, 8000)
  if (!input) return null

  try {
    const res = await fetch(OPENROUTER_EMBED_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
      signal: AbortSignal.timeout(20_000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[ai] Embedding HTTP ${res.status}: ${errText.slice(0, 300)}`)
      return null
    }

    const data = await res.json()
    const embedding = data?.data?.[0]?.embedding

    if (!Array.isArray(embedding)) {
      console.error('[ai] Embedding response had no vector')
      return null
    }

    // Guard against a model swap that changes the vector size. The database
    // column is fixed at 1536 and would reject anything else with a confusing
    // error — this catches it here with a clear message instead.
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      console.error(
        `[ai] Embedding size mismatch: got ${embedding.length}, expected ${EMBEDDING_DIMENSIONS}. ` +
        `Model "${EMBEDDING_MODEL}" does not match the database column. ` +
        `Either switch back to a 1536-dimension model or run a migration to change the column.`
      )
      return null
    }

    logUsage({
      userId: attribution?.userId,
      kind: 'embedding',
      model: EMBEDDING_MODEL,
      source: attribution?.source,
      promptTokens: data?.usage?.prompt_tokens ?? 0,
      costUsd: Number(data?.usage?.cost ?? 0),
    })

    return embedding as number[]
  } catch (err) {
    console.error('[ai] Embedding call failed:', String(err))
    return null
  }
}


// ---------------------------------------------------------------------------
// toBase64 — Uint8Array -> base64 string.
//
// btoa() only accepts a "binary string", and spreading a large Uint8Array
// straight into String.fromCharCode(...bytes) blows the call stack on
// anything past a few tens of thousands of bytes — a voice note is easily
// past that. Chunking keeps every call to String.fromCharCode small.
// ---------------------------------------------------------------------------
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}


// ---------------------------------------------------------------------------
// transcribeAudio — turn spoken audio into text.
//
// Goes through OpenRouter's /audio/transcriptions endpoint, behind the same
// OPENROUTER_API_KEY every other call in this file already uses. That is a
// deliberate choice, not the only option: OpenRouter added transcription
// (Whisper and newer models) in 2026 behind the same credentials used for
// chat and embeddings, and OPENROUTER_API_KEY is a REQUIRED key collected in
// Session 2 Step 1 — before Telegram (Session 2b) is ever set up. So this
// needs no new account for almost everyone. The 'no-key' result below exists
// anyway, for the same reason callLLM and generateEmbedding above check
// OPENROUTER_KEY rather than assume it: defense for the rare setup where it
// really is missing, not the expected path.
//
// `language` is deliberately left unset on every call — omitting it makes
// Whisper auto-detect the spoken language instead of assuming English, which
// matters because a large share of Express's intended users speak Spanish.
//
// Returns a tagged result rather than throwing, mirroring callLLM's
// never-fail-the-caller philosophy, but with enough detail (`reason`) for a
// caller like telegram-bot to say something specific back to the user
// instead of a generic failure.
// ---------------------------------------------------------------------------
export type TranscribeResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-key' | 'http' | 'network' }

export async function transcribeAudio(opts: {
  audioBytes: Uint8Array
  /** Container/extension Whisper expects — e.g. 'ogg' for Telegram's Ogg/Opus voice notes. */
  format: string
  userId?: string
  source?: string
}): Promise<TranscribeResult> {
  if (!OPENROUTER_KEY) {
    console.error('[ai] OPENROUTER_API_KEY is not set — skipping transcription')
    return { ok: false, reason: 'no-key' }
  }

  try {
    const res = await fetch(OPENROUTER_TRANSCRIBE_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: TRANSCRIPTION_MODEL,
        input_audio: { data: toBase64(opts.audioBytes), format: opts.format },
      }),
      // OpenRouter's own upstream transcription providers time out around 60s;
      // give up slightly before that so this returns a clean 'network' result
      // instead of the caller's own timeout firing first with no explanation.
      signal: AbortSignal.timeout(55_000),
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      console.error(`[ai] Transcription HTTP ${res.status}: ${errText.slice(0, 300)}`)
      return { ok: false, reason: 'http' }
    }

    const data = await res.json()
    const text = data?.text

    if (typeof text !== 'string') {
      console.error('[ai] Transcription returned no usable text')
      return { ok: false, reason: 'http' }
    }

    logUsage({
      userId: opts.userId,
      kind: 'transcription',
      model: TRANSCRIPTION_MODEL,
      source: opts.source,
      promptTokens: data?.usage?.input_tokens ?? 0,
      completionTokens: data?.usage?.output_tokens ?? 0,
      costUsd: Number(data?.usage?.cost ?? 0),
    })

    return { ok: true, text }
  } catch (err) {
    console.error('[ai] Transcription call failed:', String(err))
    return { ok: false, reason: 'network' }
  }
}
