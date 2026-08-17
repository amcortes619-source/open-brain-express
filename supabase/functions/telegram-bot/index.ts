// ============================================================================
// TELEGRAM-BOT
// ============================================================================
// Text your brain from your phone. Send it a thought and it saves. Send it a
// voice note and it transcribes and saves that too. Ask it a question and it
// searches.
//
// ---------------------------------------------------------------------------
// DEPLOY THIS ONE WITH:
//
//   npx supabase functions deploy telegram-bot --no-verify-jwt
//
// Telegram cannot send a Supabase login token — it has never heard of Supabase.
// Without that flag, Supabase rejects every message before this code runs, and
// the bot appears completely dead with nothing in the logs to explain why.
// This is the single most common reason a Telegram bot "doesn't work".
//
// Because the door is open, this function checks WHO is talking to it instead.
// Only the chat id in TELEGRAM_CHAT_ID gets through. Anyone else is politely
// turned away — otherwise a stranger who found your bot could write into your
// brain, and your AI reads that brain.
// ---------------------------------------------------------------------------

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { generateEmbedding, transcribeAudio, corsHeaders } from '../_shared/ai.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

// Bot API's current hard limit for downloading a file via getFile. Voice notes
// are nowhere near this (Telegram's Ogg/Opus voice encoding runs roughly 1KB
// per second of audio), but it is a cheap belt-and-braces check after download.
const TELEGRAM_FILE_LIMIT_BYTES = 20 * 1024 * 1024

// Not a hard platform limit — a judgment call. OpenRouter's own upstream
// transcription providers time out around 60 seconds per request, and a long
// voice note means a long base64 payload on top of a long transcription, so
// this stays well clear of that ceiling rather than finding it the hard way.
const MAX_VOICE_SECONDS = 300

function ok(): Response {
  return new Response('ok', { status: 200, headers: corsHeaders })
}

async function reply(chatId: number | string, text: string): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, 4000),      // Telegram's per-message limit
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    })
  } catch (err) {
    console.error('[telegram] Could not send reply:', String(err))
  }
}

function formatHit(
  t: { content: string; created_at: string; similarity?: number; match_source?: string; chunk_origin?: string },
  n: number
): string {
  const when = new Date(t.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const score = typeof t.similarity === 'number' && t.similarity > 0 ? ` · ${Math.round(t.similarity * 100)}%` : ''
  // match_source/chunk_origin come from search_thoughts_hybrid, not from /recent. A 'source' chunk
  // matched a passage in the full article/transcript that is NOT in the content shown below —
  // worth flagging so the match doesn't look unexplained.
  const via = t.match_source === 'chunk'
    ? (t.chunk_origin === 'source' ? ' · from full source text' : ' · excerpt')
    : ''
  const body = t.content.replace(/\s+/g, ' ').slice(0, 400)
  return `${n}. [${when}${score}${via}]\n${body}${t.content.length > 400 ? '…' : ''}`
}

// ---------------------------------------------------------------------------
// pickLang — the bot is single-tenant (one owner, locked to one chat id), so
// there is no stored language preference to consult. Telegram tells us the
// owner's own app language on every message (message.from.language_code) —
// good enough to pick between the two reply strings below without asking.
// ---------------------------------------------------------------------------
export function pickLang(message: any, en: string, es: string): string {
  const code = String(message?.from?.language_code ?? '').toLowerCase()
  return code.startsWith('es') ? es : en
}

// ---------------------------------------------------------------------------
// audioFormatFromMime — message.audio (a file sent as "audio" rather than a
// recorded "voice" note) can arrive in whatever format the sender's app used.
// message.voice is always Ogg/Opus and is handled separately, hardcoded.
// ---------------------------------------------------------------------------
function audioFormatFromMime(mime?: string): string {
  const m = (mime ?? '').toLowerCase()
  if (m.includes('mp4') || m.includes('m4a')) return 'm4a'
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3'
  if (m.includes('wav')) return 'wav'
  if (m.includes('flac')) return 'flac'
  if (m.includes('webm')) return 'webm'
  if (m.includes('ogg')) return 'ogg'
  return 'mp3'   // reasonable default; transcription will fail cleanly if it guessed wrong
}

// ---------------------------------------------------------------------------
// handleVoiceMessage — voice note or audio file in, transcribed thought out.
//
// Flow: duration gate -> getFile -> download from Telegram's file server ->
// transcribe -> save -> reply with the transcript so a mangled transcription
// is obvious immediately, not discovered later while searching the brain.
//
// IDEMPOTENCY: text messages dedupe on md5(content) — the same text always
// hashes the same way, so a Telegram retry collapses onto the same row for
// free (see _shared/save-thought.ts). Transcription does not have that
// property: re-running the exact same audio through Whisper is not
// guaranteed to produce byte-identical text on every call, so content-based
// dedup could let a retried update slip through as a second, differently-
// worded thought — silently duplicating, the exact failure save-thought.ts
// exists to prevent. Voice notes dedupe on the stable thing instead: this
// Telegram message's own id, supplied explicitly as dedup_key. The database
// trigger only fills dedup_key in when it is null (see migration.sql), so an
// explicit value here is respected, not overwritten.
// ---------------------------------------------------------------------------
export async function handleVoiceMessage(
  supabase: any,
  chatId: number | string,
  media: { file_id: string; duration?: number; file_size?: number },
  message: any,
  opts: { format: string; source: string },
): Promise<Response> {
  if (typeof media.duration === 'number' && media.duration > MAX_VOICE_SECONDS) {
    const minutes = Math.round(media.duration / 60)
    const limitMinutes = MAX_VOICE_SECONDS / 60
    await reply(chatId, pickLang(message,
      `That voice note is about ${minutes} minute${minutes === 1 ? '' : 's'} — a bit long to transcribe reliably in one go. Keep it under ${limitMinutes} minutes, or split it into two.`,
      `Esa nota de voz dura como ${minutes} minuto${minutes === 1 ? '' : 's'} — es mucho para transcribir de una vez de forma confiable. Mantenla bajo ${limitMinutes} minutos, o divídela en dos.`))
    return ok()
  }

  let fileBytes: Uint8Array
  try {
    const fileRes = await fetch(
      `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(media.file_id)}`,
      { signal: AbortSignal.timeout(10_000) }
    )
    const fileData = await fileRes.json()
    const filePath = fileData?.result?.file_path
    if (!fileData?.ok || !filePath) throw new Error(fileData?.description ?? 'getFile did not return a file_path')

    const downloadRes = await fetch(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`,
      { signal: AbortSignal.timeout(30_000) }
    )
    if (!downloadRes.ok) throw new Error(`file download HTTP ${downloadRes.status}`)

    const buf = await downloadRes.arrayBuffer()
    if (buf.byteLength > TELEGRAM_FILE_LIMIT_BYTES) throw new Error('downloaded file exceeds the size limit')
    fileBytes = new Uint8Array(buf)
  } catch (err) {
    console.error('[telegram] Voice download failed:', String(err))
    await reply(chatId, pickLang(message,
      'Could not download that voice note from Telegram. Try sending it again.',
      'No se pudo descargar esa nota de voz de Telegram. Intenta enviarla de nuevo.'))
    return ok()
  }

  const result = await transcribeAudio({
    audioBytes: fileBytes,
    format: opts.format,
    userId: OWNER_USER_ID,
    source: 'telegram-bot',
  })

  if (!result.ok) {
    const msg = result.reason === 'no-key'
      ? pickLang(message,
          'Voice notes need one more key: an OpenRouter key. You most likely already added one for the rest of the app back in Session 2, Step 1 — if OPENROUTER_API_KEY is set in Supabase, tell Claude Code to redeploy this function and it will pick it up. If you never added one, tell Claude Code: "set OPENROUTER_API_KEY" and it will walk you through it. Text still works normally either way.',
          'Las notas de voz necesitan una llave más: una llave de OpenRouter. Seguramente ya agregaste una para el resto de la app en la Sesión 2, Paso 1 — si OPENROUTER_API_KEY ya está puesta en Supabase, dile a Claude Code que vuelva a desplegar esta función y la va a usar. Si nunca agregaste una, dile a Claude Code: "set OPENROUTER_API_KEY" y te guía. El texto sigue funcionando normal de cualquier forma.')
      : pickLang(message,
          'Could not transcribe that voice note. Text still works normally — try again in a minute, or just type it.',
          'No se pudo transcribir esa nota de voz. El texto sigue funcionando normal — intenta de nuevo en un minuto, o escríbelo.')
    await reply(chatId, msg)
    return ok()
  }

  const transcript = result.text.trim()
  if (!transcript) {
    await reply(chatId, pickLang(message,
      'That came back empty — might have been silence, or too quiet to make out. Nothing was saved.',
      'Eso salió vacío — puede que fuera silencio, o que no se entendiera bien. No se guardó nada.'))
    return ok()
  }

  try {
    const saved = await saveThoughtRow(supabase, {
      user_id: OWNER_USER_ID,
      content: transcript,
      source: opts.source,
      // Explicit, not content-derived — see the idempotency note above.
      dedup_key: `telegram-voice:${message.message_id}`,
      metadata: {
        from: message.from?.first_name ?? null,
        duration_seconds: media.duration ?? null,
      },
    })

    const preview = transcript.length > 500 ? transcript.slice(0, 500) + '…' : transcript
    await reply(chatId, saved.deduped
      ? pickLang(message,
          `Already had that one saved — no new copy made.\n\n🎙️ "${preview}"`,
          `Ya tenía esa nota guardada — no se hizo una copia nueva.\n\n🎙️ "${preview}"`)
      : pickLang(message,
          `✅ Saved from voice:\n\n🎙️ "${preview}"`,
          `✅ Guardado desde voz:\n\n🎙️ "${preview}"`))
  } catch (err: any) {
    console.error('[telegram] Voice save failed:', String(err))
    await reply(chatId, pickLang(message,
      `Transcribed it, but could not save it: ${err?.message ?? String(err)}`,
      `Se transcribió, pero no se pudo guardar: ${err?.message ?? String(err)}`))
  }
  return ok()
}

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // ALWAYS return 200 to Telegram, whatever happens. A non-200 makes Telegram
  // retry the same message over and over for hours.
  try {
    const update = await req.json()
    const message = update?.message ?? update?.edited_message
    if (!message) return ok()

    const chatId = message.chat?.id
    if (!chatId) return ok()

    // --- who is this? -----------------------------------------------------
    if (!ALLOWED_CHAT_ID) {
      // Not locked down yet. Tell the owner their id so they can lock it.
      await reply(chatId,
        `This brain is not finished setting up.\n\n` +
        `Your chat id is: ${chatId}\n\n` +
        `Tell Claude Code: "set TELEGRAM_CHAT_ID to ${chatId} and redeploy the telegram bot"`)
      return ok()
    }

    if (String(chatId) !== String(ALLOWED_CHAT_ID)) {
      await reply(chatId, 'This is a private brain. It does not talk to strangers.')
      console.log(`[telegram] Rejected chat ${chatId}`)
      return ok()
    }

    if (!OWNER_USER_ID) {
      await reply(chatId, 'Setup incomplete: OWNER_USER_ID is missing from the Supabase secrets.')
      return ok()
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // --- voice note or audio file -----------------------------------------
    if (message.voice) {
      return await handleVoiceMessage(supabase, chatId, message.voice, message,
        { format: 'ogg', source: 'telegram-voice' })
    }
    if (message.audio) {
      return await handleVoiceMessage(supabase, chatId, message.audio, message,
        { format: audioFormatFromMime(message.audio.mime_type), source: 'telegram-audio' })
    }

    const text: string = (message.text ?? '').trim()
    if (!text) return ok()

    // --- /start, /help ----------------------------------------------------
    if (text === '/start' || text === '/help') {
      await reply(chatId,
        `🧠 Your Open Brain\n\n` +
        `Just send me anything and I will save it. Voice notes work too.\n\n` +
        `? your question — search your brain\n` +
        `/recent — the last few things you saved\n` +
        `/count — how much is in there\n\n` +
        `Everything you send gets tagged and connected to related thoughts ` +
        `automatically, within a few seconds.`)
      return ok()
    }

    // --- /count -----------------------------------------------------------
    if (text === '/count') {
      const { count } = await supabase
        .from('thoughts')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', OWNER_USER_ID)
      const { count: links } = await supabase
        .from('thought_links')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', OWNER_USER_ID)
      await reply(chatId, `🧠 ${count ?? 0} thoughts, ${links ?? 0} connections between them.`)
      return ok()
    }

    // --- /recent ----------------------------------------------------------
    if (text === '/recent') {
      const { data } = await supabase
        .from('thoughts')
        .select('content, created_at')
        .eq('user_id', OWNER_USER_ID)
        .order('created_at', { ascending: false })
        .limit(5)

      if (!data?.length) {
        await reply(chatId, 'Nothing saved yet.')
        return ok()
      }
      await reply(chatId, `🕐 Your last ${data.length}:\n\n` + data.map(formatHit).join('\n\n'))
      return ok()
    }

    // --- search: "?something" or "/search something" ----------------------
    const searchMatch = text.match(/^(?:\?|\/search\s+)(.+)$/s)
    if (searchMatch) {
      const query = searchMatch[1].trim()
      if (!query) {
        await reply(chatId, 'Search for what? Try: ? marketing ideas')
        return ok()
      }

      // Meaning and exact-word matching in one call, fused by rank.
      const embedding = await generateEmbedding(query, { userId: OWNER_USER_ID, source: 'telegram-bot' })
      const { data } = await supabase.rpc('search_thoughts_hybrid', {
        p_user_id: OWNER_USER_ID,
        query_text: query,
        query_embedding: embedding,
        match_threshold: 0.3,
        match_count: 5,
      })
      const rows = data ?? []

      if (rows.length === 0) {
        await reply(chatId, `Nothing in your brain about "${query}".`)
        return ok()
      }

      await reply(chatId,
        `🔍 ${rows.length} result${rows.length === 1 ? '' : 's'} for "${query}":\n\n` +
        rows.map(formatHit).join('\n\n'))
      return ok()
    }

    // --- anything else: save it -------------------------------------------
    try {
      const saved = await saveThoughtRow(supabase, {
        user_id: OWNER_USER_ID,
        content: text,
        source: 'telegram',
        metadata: { from: message.from?.first_name ?? null },
      })
      const words = text.split(/\s+/).length
      await reply(
        chatId,
        saved.deduped
          ? `Already had that one saved — no new copy made.`
          : `✅ Saved (${words} word${words === 1 ? '' : 's'}). Tagging it now.`
      )
    } catch (err: any) {
      console.error('[telegram] Save failed:', String(err))
      await reply(chatId, `Could not save that: ${err?.message ?? String(err)}`)
    }
    return ok()

  } catch (err) {
    console.error('[telegram] Unexpected failure:', String(err))
    return ok()
  }
}

// Guarded so importing this module for tests does not start a server —
// import.meta.main is only true when this file is run directly, which is
// exactly what deploying/serving it does.
if (import.meta.main) {
  Deno.serve(handleRequest)
}
