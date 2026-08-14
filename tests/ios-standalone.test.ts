// ============================================================================
// isIOSDevice / isStandaloneDisplay — unit tests against the REAL source.
//
// index.html is deliberately one self-contained file (Session 2 has the
// student paste its entire contents into GitHub's editor) rather than a
// separate .js module, so there is nothing to `import` here. Instead this
// extracts the exact function source between the IOS-STANDALONE-DETECT
// markers in index.html and evaluates it, so the test exercises the actual
// shipped code — not a hand-copied duplicate that could drift out of sync.
//
//   npx deno@2.1.4 test --allow-env --allow-read --no-check tests/ios-standalone.test.ts
// ============================================================================

const html = await Deno.readTextFile(new URL('../index.html', import.meta.url))

const start = html.indexOf('// IOS-STANDALONE-DETECT:START')
const end = html.indexOf('// IOS-STANDALONE-DETECT:END')
if (start === -1 || end === -1 || end < start) {
  throw new Error('Could not find the IOS-STANDALONE-DETECT markers in index.html — did they get renamed or removed?')
}
const source = html.slice(start, end)

// deno-lint-ignore no-explicit-any
const factory = new Function(`${source}\nreturn { isIOSDevice, isStandaloneDisplay };`) as () => any
const { isIOSDevice, isStandaloneDisplay } = factory()

function nav(overrides: Record<string, unknown>) {
  return { userAgent: '', platform: '', maxTouchPoints: 0, standalone: undefined, ...overrides }
}
function win(matches: boolean) {
  return { matchMedia: (_q: string) => ({ matches }) }
}

Deno.test('isIOSDevice: true for iPhone/iPad/iPod user agents', () => {
  const iphoneUA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
  const ipadUA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15'
  if (!isIOSDevice(nav({ userAgent: iphoneUA }))) throw new Error('iPhone UA should be detected as iOS')
  if (!isIOSDevice(nav({ userAgent: ipadUA }))) throw new Error('iPad UA should be detected as iOS')
})

Deno.test('isIOSDevice: true for iPadOS reporting as MacIntel with touch points (the modern iPad case)', () => {
  const macLikeIpad = nav({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5,
  })
  if (!isIOSDevice(macLikeIpad)) throw new Error('iPadOS-as-Mac should still be detected as iOS')
})

Deno.test('isIOSDevice: false for a real Mac (MacIntel, no touch) and for Android', () => {
  const realMac = nav({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 0,
  })
  if (isIOSDevice(realMac)) throw new Error('a real Mac with no touch points must not read as iOS')

  const android = nav({
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0',
    platform: 'Linux armv8l',
  })
  if (isIOSDevice(android)) throw new Error('Android must not read as iOS')
})

Deno.test('isStandaloneDisplay: true when navigator.standalone is true (Safari signal)', () => {
  if (!isStandaloneDisplay(nav({ standalone: true }), win(false))) {
    throw new Error('navigator.standalone === true should count as standalone')
  }
})

Deno.test('isStandaloneDisplay: true when display-mode: standalone matches (standard signal)', () => {
  if (!isStandaloneDisplay(nav({}), win(true))) {
    throw new Error('a matching display-mode: standalone media query should count as standalone')
  }
})

Deno.test('isStandaloneDisplay: false in an ordinary browser tab (neither signal present)', () => {
  if (isStandaloneDisplay(nav({}), win(false))) {
    throw new Error('a plain browser tab must not read as standalone')
  }
})

Deno.test('combined: warning only fires for iOS AND standalone together', () => {
  const iosTab = { device: nav({ userAgent: 'iPhone', standalone: false }), win: win(false) }
  const iosInstalled = { device: nav({ userAgent: 'iPhone', standalone: true }), win: win(false) }
  const androidInstalled = { device: nav({ userAgent: 'Android', standalone: false }), win: win(true) }

  const blocked = (c: typeof iosTab) => isIOSDevice(c.device) && isStandaloneDisplay(c.device, c.win)

  if (blocked(iosTab)) throw new Error('iOS in a plain Safari tab must NOT be warned — voice works there')
  if (!blocked(iosInstalled)) throw new Error('iOS installed standalone MUST be warned — this is the actual bug')
  if (blocked(androidInstalled)) throw new Error('Android must NEVER be warned, installed or not')
})
