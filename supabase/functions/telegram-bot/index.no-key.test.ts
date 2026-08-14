// ============================================================================
// handleVoiceMessage — the "no transcription key configured" reply.
//
// RUN THIS FILE ON ITS OWN — see the comment in
// _shared/ai.with-key.test.ts for why: OPENROUTER_API_KEY is read once at
// module import time, and deno test shares one module cache across every
// file in a single run.
//   npx deno@2.1.4 test --allow-env --no-check supabase/functions/telegram-bot/index.no-key.test.ts
// ============================================================================

Deno.env.delete('OPENROUTER_API_KEY')
Deno.env.set('OWNER_USER_ID', 'owner-1')
Deno.env.set('TELEGRAM_BOT_TOKEN', 'TESTTOKEN')
Deno.env.set('SUPABASE_URL', 'http://localhost:0')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')

const { handleVoiceMessage } = await import('./index.ts')

Deno.test('handleVoiceMessage: no OpenRouter key -> replies in the sender\'s language, never touches the database', async () => {
  const sentMessages: string[] = []
  let saveCalled = false

  const orig = globalThis.fetch
  // @ts-ignore — test stub
  globalThis.fetch = async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/f1.oga' } }), { status: 200 })
    }
    if (u.includes('/file/bot')) {
      return new Response(new Uint8Array([1, 2, 3, 4]).buffer, { status: 200 })
    }
    if (u.includes('/sendMessage')) {
      sentMessages.push(JSON.parse(init.body).text)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    throw new Error('unexpected fetch: ' + u)
  }

  const fakeSupabase = {
    from() {
      saveCalled = true
      throw new Error('save must never be reached when transcription failed')
    },
  }

  try {
    const message = { message_id: 1, chat: { id: 999 }, from: { language_code: 'es-MX' } }
    const res = await handleVoiceMessage(
      fakeSupabase as any,
      999,
      { file_id: 'abc', duration: 5 },
      message,
      { format: 'ogg', source: 'telegram-voice' },
    )
    if (res.status !== 200) throw new Error('handler must always return 200 to Telegram')
  } finally {
    globalThis.fetch = orig
  }

  if (saveCalled) throw new Error('a thought must not be saved when transcription could not run')
  if (sentMessages.length !== 1) throw new Error('expected exactly one reply, got ' + sentMessages.length)
  const reply = sentMessages[0]
  if (!/OpenRouter/.test(reply)) throw new Error('reply should name the missing key: ' + reply)
  if (!/Sesi[oó]n 2/.test(reply)) throw new Error('reply should be in Spanish (language_code es-MX): ' + reply)
})
