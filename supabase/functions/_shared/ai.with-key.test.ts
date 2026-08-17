// ============================================================================
// transcribeAudio — tests that need OPENROUTER_API_KEY set.
//
// RUN THIS FILE ON ITS OWN, not together with ai.no-key.test.ts:
//   npx deno@2.1.4 test --allow-env --no-check supabase/functions/_shared/ai.with-key.test.ts
//
// Why separate: OPENROUTER_KEY is read from the environment once, at module
// import time (see ai.ts). `deno test` on a whole directory shares one module
// cache across every matched file, so importing ai.ts with the key set here
// and unset in ai.no-key.test.ts in the SAME process would make whichever
// file imports first "win" for both. Running one file per process sidesteps
// that entirely — each `deno test <file>` invocation is its own process.
// ============================================================================

Deno.env.set('OPENROUTER_API_KEY', 'test-key-for-unit-tests')

const { transcribeAudio } = await import('./ai.ts')

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = globalThis.fetch
  // @ts-ignore — test stub
  globalThis.fetch = handler
  return () => { globalThis.fetch = orig }
}

Deno.test('transcribeAudio: returns the transcript on a 2xx response', async () => {
  let sawBody: any = null
  const restore = stubFetch(async (url, init) => {
    if (String(url).includes('/audio/transcriptions')) {
      sawBody = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({
        text: 'hola, esto es una prueba',
        usage: { input_tokens: 12, output_tokens: 6, cost: 0.00012 },
      }), { status: 200 })
    }
    if (String(url).includes('/llm_usage')) return new Response(null, { status: 201 })
    throw new Error('unexpected fetch: ' + url)
  })
  try {
    const result = await transcribeAudio({
      audioBytes: new Uint8Array([1, 2, 3, 4, 5]),
      format: 'ogg',
      userId: 'user-1',
      source: 'test',
    })
    if (!result.ok) throw new Error('expected ok:true, got ' + JSON.stringify(result))
    if (result.text !== 'hola, esto es una prueba') throw new Error('unexpected text: ' + result.text)
    if (sawBody.model !== 'openai/whisper-1') throw new Error('unexpected model: ' + sawBody.model)
    if (sawBody.input_audio.format !== 'ogg') throw new Error('unexpected format: ' + sawBody.input_audio.format)
    // Language auto-detection matters for Spanish audio — must never be pinned to English.
    if ('language' in sawBody) throw new Error('language must be left unset so Whisper auto-detects')
  } finally {
    restore()
  }
})

Deno.test('transcribeAudio: reports reason "http" on a non-2xx response', async () => {
  const restore = stubFetch(async () => new Response('server error', { status: 500 }))
  try {
    const result = await transcribeAudio({ audioBytes: new Uint8Array([1]), format: 'ogg' })
    if (result.ok) throw new Error('expected ok:false')
    if (result.reason !== 'http') throw new Error('expected reason "http", got ' + result.reason)
  } finally {
    restore()
  }
})

Deno.test('transcribeAudio: reports reason "network" when fetch itself throws', async () => {
  const restore = stubFetch(async () => { throw new TypeError('network down') })
  try {
    const result = await transcribeAudio({ audioBytes: new Uint8Array([1]), format: 'ogg' })
    if (result.ok) throw new Error('expected ok:false')
    if (result.reason !== 'network') throw new Error('expected reason "network", got ' + result.reason)
  } finally {
    restore()
  }
})

Deno.test('transcribeAudio: reports reason "http" when the response has no usable text', async () => {
  const restore = stubFetch(async () => new Response(JSON.stringify({ nonsense: true }), { status: 200 }))
  try {
    const result = await transcribeAudio({ audioBytes: new Uint8Array([1]), format: 'ogg' })
    if (result.ok) throw new Error('expected ok:false')
    if (result.reason !== 'http') throw new Error('expected reason "http", got ' + result.reason)
  } finally {
    restore()
  }
})
