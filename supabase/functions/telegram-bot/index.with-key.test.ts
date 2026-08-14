// ============================================================================
// handleVoiceMessage — tests that need OPENROUTER_API_KEY set.
//
// RUN THIS FILE ON ITS OWN, not together with index.no-key.test.ts — see the
// comment in _shared/ai.with-key.test.ts for why.
//   npx deno@2.1.4 test --allow-env --no-check supabase/functions/telegram-bot/index.with-key.test.ts
// ============================================================================

Deno.env.set('OPENROUTER_API_KEY', 'test-key-for-unit-tests')
Deno.env.set('OWNER_USER_ID', 'owner-1')
Deno.env.set('TELEGRAM_BOT_TOKEN', 'TESTTOKEN')
Deno.env.set('SUPABASE_URL', 'http://localhost:0')
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'test-service-key')

const { handleVoiceMessage, pickLang } = await import('./index.ts')

// ---------------------------------------------------------------------------
// A minimal in-memory stand-in for the one Supabase call saveThoughtRow makes:
//   supabase.from('thoughts').upsert(payload, opts).select(cols).single()
// Reproduces the real dedup semantics from migration.sql closely enough to
// exercise saveThoughtRow's own "deduped" calculation: a repeat write for a
// key that already exists returns the ORIGINAL created_at, not a fresh one.
// ---------------------------------------------------------------------------
function makeFakeThoughtsTable(store: Map<string, { id: string; created_at: string }>) {
  let insertCount = 0
  const client = {
    _insertCount: () => insertCount,
    from(table: string) {
      if (table !== 'thoughts') throw new Error('unexpected table: ' + table)
      return {
        upsert(payload: any) {
          return {
            select() {
              return {
                async single() {
                  const key = `${payload.dedup_key}|${payload.user_id}`
                  const existing = store.get(key)
                  if (existing) {
                    return { data: { id: existing.id, created_at: existing.created_at }, error: null }
                  }
                  insertCount++
                  const row = { id: `row-${insertCount}`, created_at: new Date().toISOString() }
                  store.set(key, row)
                  return { data: row, error: null }
                },
              }
            },
          }
        },
      }
    },
  }
  return client
}

function stubTelegramAndTranscription(opts: {
  transcriptText: string
  sentMessages: string[]
  fileBytes?: Uint8Array
}): () => void {
  const orig = globalThis.fetch
  // @ts-ignore — test stub
  globalThis.fetch = async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/getFile')) {
      return new Response(JSON.stringify({ ok: true, result: { file_path: 'voice/f1.oga' } }), { status: 200 })
    }
    if (u.includes('/file/bot')) {
      return new Response((opts.fileBytes ?? new Uint8Array([9, 9, 9])).buffer, { status: 200 })
    }
    if (u.includes('/audio/transcriptions')) {
      return new Response(JSON.stringify({
        text: opts.transcriptText,
        usage: { input_tokens: 5, output_tokens: 5, cost: 0.00005 },
      }), { status: 200 })
    }
    if (u.includes('/sendMessage')) {
      opts.sentMessages.push(JSON.parse(init.body).text)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    if (u.includes('/llm_usage')) {
      return new Response(null, { status: 201 })
    }
    throw new Error('unexpected fetch: ' + u)
  }
  return () => { globalThis.fetch = orig }
}

Deno.test('handleVoiceMessage: happy path saves the transcript and replies with it', async () => {
  const store = new Map()
  const supabase = makeFakeThoughtsTable(store)
  const sentMessages: string[] = []
  const restore = stubTelegramAndTranscription({ transcriptText: 'una idea nueva sobre el negocio', sentMessages })

  try {
    const message = { message_id: 100, chat: { id: 999 }, from: { language_code: 'es' } }
    const res = await handleVoiceMessage(
      supabase as any, 999, { file_id: 'abc', duration: 12 }, message,
      { format: 'ogg', source: 'telegram-voice' },
    )
    if (res.status !== 200) throw new Error('expected 200')
  } finally {
    restore()
  }

  if (store.size !== 1) throw new Error('expected exactly one saved row, got ' + store.size)
  if (sentMessages.length !== 1) throw new Error('expected exactly one reply')
  if (!sentMessages[0].includes('una idea nueva sobre el negocio')) {
    throw new Error('reply should echo the transcript back: ' + sentMessages[0])
  }
  if (!sentMessages[0].startsWith('✅')) throw new Error('first save should read as a save, not a dedup: ' + sentMessages[0])
})

Deno.test('handleVoiceMessage: a repeated Telegram update for the same message collapses onto one row (idempotent)', async () => {
  const store = new Map<string, { id: string; created_at: string }>()
  // Simulate: this exact voice message (message_id 100) was already processed
  // by an earlier webhook delivery a few seconds ago. Telegram is now
  // retrying the same update because it never saw our 200 OK in time.
  store.set('telegram-voice:100|owner-1', { id: 'row-1', created_at: new Date(Date.now() - 15_000).toISOString() })
  const supabase = makeFakeThoughtsTable(store)
  const sentMessages: string[] = []

  // Deliberately transcribe to SLIGHTLY DIFFERENT text than "the first time" would
  // have produced — Whisper is not guaranteed byte-identical across two calls on
  // identical audio. Content-based dedup would treat this as a new thought;
  // dedup_key is keyed on message_id specifically so this must still collapse.
  const restore = stubTelegramAndTranscription({ transcriptText: 'una idea nueva sobre el negocio (retry wording)', sentMessages })

  try {
    const message = { message_id: 100, chat: { id: 999 }, from: { language_code: 'es' } }
    const res = await handleVoiceMessage(
      supabase as any, 999, { file_id: 'abc', duration: 12 }, message,
      { format: 'ogg', source: 'telegram-voice' },
    )
    if (res.status !== 200) throw new Error('expected 200')
  } finally {
    restore()
  }

  if (store.size !== 1) throw new Error('expected still exactly one row after the retry, got ' + store.size)
  if ((supabase as any)._insertCount() !== 0) throw new Error('retry must not perform a fresh insert')
  if (sentMessages.length !== 1) throw new Error('expected exactly one reply')
  if (!/Ya ten[ií]a esa nota guardada/.test(sentMessages[0])) {
    throw new Error('reply should say it was already saved, not save it again: ' + sentMessages[0])
  }
})

Deno.test('handleVoiceMessage: a voice note over the duration cap is rejected before any network call', async () => {
  let fetchCalled = false
  const orig = globalThis.fetch
  // @ts-ignore — test stub
  globalThis.fetch = async () => { fetchCalled = true; throw new Error('should never be reached') }

  const sentReplies: string[] = []
  // Patch fetch AFTER capturing orig, but the too-long path replies via fetch too —
  // so stub sendMessage specifically rather than blocking every call.
  // @ts-ignore
  globalThis.fetch = async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/sendMessage')) {
      sentReplies.push(JSON.parse(init.body).text)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    fetchCalled = true
    throw new Error('unexpected fetch for a too-long voice note: ' + u)
  }

  try {
    const message = { message_id: 200, chat: { id: 999 }, from: { language_code: 'en' } }
    const res = await handleVoiceMessage(
      {} as any, 999, { file_id: 'abc', duration: 600 }, message,
      { format: 'ogg', source: 'telegram-voice' },
    )
    if (res.status !== 200) throw new Error('expected 200')
  } finally {
    globalThis.fetch = orig
  }

  if (sentReplies.length !== 1) throw new Error('expected exactly one reply')
  if (!/long/i.test(sentReplies[0])) throw new Error('reply should explain it was too long: ' + sentReplies[0])
})

Deno.test('handleVoiceMessage: a download failure replies plainly instead of failing silently', async () => {
  const sentReplies: string[] = []
  const orig = globalThis.fetch
  // @ts-ignore
  globalThis.fetch = async (url: any, init?: any) => {
    const u = String(url)
    if (u.includes('/getFile')) return new Response(JSON.stringify({ ok: false, description: 'boom' }), { status: 200 })
    if (u.includes('/sendMessage')) {
      sentReplies.push(JSON.parse(init.body).text)
      return new Response(JSON.stringify({ ok: true }), { status: 200 })
    }
    throw new Error('unexpected fetch: ' + u)
  }

  try {
    const message = { message_id: 300, chat: { id: 999 }, from: { language_code: 'en' } }
    const res = await handleVoiceMessage(
      {} as any, 999, { file_id: 'abc', duration: 5 }, message,
      { format: 'ogg', source: 'telegram-voice' },
    )
    if (res.status !== 200) throw new Error('expected 200')
  } finally {
    globalThis.fetch = orig
  }

  if (sentReplies.length !== 1) throw new Error('expected exactly one reply')
  if (!/download/i.test(sentReplies[0])) throw new Error('reply should mention the download failed: ' + sentReplies[0])
})

Deno.test('pickLang: picks Spanish only for an es*-tagged sender, English otherwise', () => {
  if (pickLang({ from: { language_code: 'es' } }, 'EN', 'ES') !== 'ES') throw new Error('es failed')
  if (pickLang({ from: { language_code: 'es-MX' } }, 'EN', 'ES') !== 'ES') throw new Error('es-MX failed')
  if (pickLang({ from: { language_code: 'en' } }, 'EN', 'ES') !== 'EN') throw new Error('en failed')
  if (pickLang({ from: {} }, 'EN', 'ES') !== 'EN') throw new Error('missing code should default to EN')
  if (pickLang({}, 'EN', 'ES') !== 'EN') throw new Error('missing from should default to EN')
})
