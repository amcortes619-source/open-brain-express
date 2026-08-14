// ============================================================================
// transcribeAudio — the "no key configured" path.
//
// RUN THIS FILE ON ITS OWN — see the comment in ai.with-key.test.ts for why.
//   npx deno@2.1.4 test --allow-env --no-check supabase/functions/_shared/ai.no-key.test.ts
// ============================================================================

Deno.env.delete('OPENROUTER_API_KEY')

const { transcribeAudio } = await import('./ai.ts')

Deno.test('transcribeAudio: reports reason "no-key" and never calls fetch when the key is missing', async () => {
  let called = false
  const orig = globalThis.fetch
  // @ts-ignore — test stub
  globalThis.fetch = async () => { called = true; throw new Error('fetch should not be reached') }
  try {
    const result = await transcribeAudio({ audioBytes: new Uint8Array([1, 2, 3]), format: 'ogg' })
    if (result.ok) throw new Error('expected ok:false')
    if (result.reason !== 'no-key') throw new Error('expected reason "no-key", got ' + result.reason)
    if (called) throw new Error('fetch must not be called at all when OPENROUTER_API_KEY is unset')
  } finally {
    globalThis.fetch = orig
  }
})
