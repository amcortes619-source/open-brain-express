// ============================================================================
// TELEGRAM-BOT
// ============================================================================
// Text your brain from your phone. Send it a thought and it saves. Ask it a
// question and it searches.
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
import { generateEmbedding, corsHeaders } from '../_shared/ai.ts'
import { saveThoughtRow } from '../_shared/save-thought.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? ''
const OWNER_USER_ID = Deno.env.get('OWNER_USER_ID') ?? ''
const ALLOWED_CHAT_ID = Deno.env.get('TELEGRAM_CHAT_ID') ?? ''

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  // ALWAYS return 200 to Telegram, whatever happens. A non-200 makes Telegram
  // retry the same message over and over for hours.
  const ok = () => new Response('ok', { status: 200, headers: corsHeaders })

  try {
    const update = await req.json()
    const message = update?.message ?? update?.edited_message
    if (!message) return ok()

    const chatId = message.chat?.id
    const text: string = (message.text ?? '').trim()
    if (!chatId || !text) return ok()

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

    // --- /start, /help ----------------------------------------------------
    if (text === '/start' || text === '/help') {
      await reply(chatId,
        `🧠 Your Open Brain\n\n` +
        `Just send me anything and I will save it.\n\n` +
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
})
