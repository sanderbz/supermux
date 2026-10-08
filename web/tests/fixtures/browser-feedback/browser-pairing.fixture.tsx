// Run in a fresh Bun process: React/Radix detect DOM availability when first imported.
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://supermux.example' })
const w = dom.window
const globalNames = ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLInputElement', 'HTMLButtonElement', 'getComputedStyle', 'localStorage', 'IS_REACT_ACT_ENVIRONMENT', 'requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']
const previousGlobals = new Map(globalNames.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'KeyboardEvent', 'HTMLInputElement', 'HTMLButtonElement', 'getComputedStyle', 'localStorage']) {
  Object.defineProperty(globalThis, key, { value: key === 'getComputedStyle' ? w.getComputedStyle.bind(w) : (w as unknown as Record<string, unknown>)[key], configurable: true, writable: true })
}
Object.assign(w, { _SUPERMUX_AUTH_TOKEN: 'owner-secret', _SUPERMUX_BASE_URL: '', matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) })
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0), cancelAnimationFrame: clearTimeout, ResizeObserver: class { observe() {} unobserve() {} disconnect() {} } })
const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { BrowserPairingButton, BrowserFeedbackCard, supportsBrowserFeedback, browserFeedbackError } = await import('../../../src/components/browser-feedback/browser-pairing')
const { useViewer } = await import('../../../src/stores/viewer-store')

let checks = 0
async function run() {
  const calls: { url: string; init?: RequestInit }[] = []
  const oldFetch = globalThis.fetch
  const oldViewer = useViewer.getState().viewer
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    if (!w._SUPERMUX_AUTH_TOKEN && ['POST', 'DELETE'].includes(init?.method || '') && ((init?.headers as Record<string, string>)?.['x-supermux-csrf'] !== 'member=csrf' || init?.credentials !== 'same-origin')) return new Response(JSON.stringify({ ok: false, error: 'CSRF required' }), { status: 403 })
    const data = init?.method === 'POST' ? { id: 'binding', origin: 'https://site.example', session: 'claude-demo' } : init?.method === 'DELETE' ? { id: 'binding', revoked: true } : []
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  const container = w.document.getElementById('root')!
  const root = createRoot(container)
  try {
    useViewer.setState({ viewer: { kind: 'owner' } })
    await React.act(async () => { root.render(<BrowserPairingButton session="claude-demo" />) })
    await React.act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="chat-pair-browser"]')!.click() })
    checks++; assert.equal(calls[0].url, '/api/sessions/claude-demo/browser-bindings')
    const input = w.document.querySelector('[data-testid="browser-pair-code"]') as HTMLInputElement
    checks++; assert.notEqual(w.document.activeElement, input)
    checks++; assert.equal(w.document.querySelector('[data-testid="browser-extension-download"]')?.getAttribute('href'), '/downloads/supermux-browser-extension.zip')
    checks++; assert.ok(String(w.document.body.textContent).includes('Feedback Chrome Extension'))
    checks++; assert.ok(String(w.document.body.textContent).includes('Install once. Reuse the same extension across agents and companies you can access.'))
    checks++; assert.ok(String(w.document.body.textContent).includes('Open Supermux on the website you want to connect.'))
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(input, '1234')
      input.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    await React.act(async () => { input.closest('form')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
    const claim = calls.find(c => c.init?.method === 'POST')!
    checks++; assert.equal(claim.url, '/api/sessions/claude-demo/browser-pairings')
    checks++; assert.deepEqual(JSON.parse(String(claim.init?.body)), { code: '1234' })
    checks++; assert.equal((claim.init?.headers as Record<string, string>).Authorization, 'Bearer owner-secret')
    checks++; assert.ok(String(w.document.body.textContent).includes('Code accepted for https://site.example'))
    await React.act(async () => { w.document.querySelector<HTMLButtonElement>('[aria-label="Disconnect https://site.example"]')!.click() })
    checks++; assert.equal(calls.at(-1)?.url, '/api/sessions/claude-demo/browser-bindings/binding')
    checks++; assert.equal(calls.at(-1)?.init?.method, 'DELETE')
    checks++; assert.equal(w.document.querySelector('[aria-label="Disconnect https://site.example"]'), null)
    await React.act(async () => { useViewer.setState({ viewer: { kind: 'pending' } }) })
    checks++; assert.equal(container.querySelector('[data-testid="chat-pair-browser"]'), null)
    await React.act(async () => { useViewer.setState({ viewer: { kind: 'member', companyId: 1, userId: 1, role: 'member', displayName: 'Member', email: 'member@example.com' } }) })
    checks++; assert.notEqual(container.querySelector('[data-testid="chat-pair-browser"]'), null)
    // The settings section is inline, with no nested modal or keyboard autofocus.
    w.document.cookie = 'supermux_csrf=member%3Dcsrf; path=/'
    w._SUPERMUX_AUTH_TOKEN = undefined
    await React.act(async () => { root.render(<BrowserFeedbackCard session="codex-demo" label="Codex" />) })
    checks++; assert.notEqual(container.querySelector('[data-testid="browser-feedback-card"]'), null)
    checks++; assert.equal(w.document.querySelector('[role="dialog"]'), null)
    const memberInput = container.querySelector<HTMLInputElement>('[data-testid="browser-pair-code"]')!
    checks++; assert.equal(memberInput.autofocus, false)
    checks++; assert.ok(String(container.textContent).includes('desktop'))
    checks++; assert.ok(String(container.textContent).includes('Pair a website with Codex'))
    checks++; assert.equal(container.querySelector('[data-testid="browser-extension-download"]')?.getAttribute('href'), '/downloads/supermux-browser-extension.zip')
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(memberInput, '5678')
      memberInput.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    await React.act(async () => { memberInput.closest('form')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
    const memberClaim = calls.filter(c => c.init?.method === 'POST').at(-1)!
    checks++; assert.equal(memberClaim.url, '/api/sessions/codex-demo/browser-pairings')
    checks++; assert.deepEqual(JSON.parse(String(memberClaim.init?.body)), { code: '5678' })
    checks++; assert.equal((memberClaim.init?.headers as Record<string, string>).Authorization, undefined)
    checks++; assert.equal((memberClaim.init?.headers as Record<string, string>)['x-supermux-csrf'], 'member=csrf')
    checks++; assert.equal(memberClaim.init?.credentials, 'same-origin')
    await React.act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Disconnect https://site.example"]')!.click() })
    const memberRevoke = calls.at(-1)!
    checks++; assert.equal(memberRevoke.url, '/api/sessions/codex-demo/browser-bindings/binding')
    checks++; assert.equal((memberRevoke.init?.headers as Record<string, string>)['x-supermux-csrf'], 'member=csrf')
    checks++; assert.equal(memberRevoke.init?.credentials, 'same-origin')
    checks++; assert.equal((memberRevoke.init?.headers as Record<string, string>).Authorization, undefined)
    checks++; assert.equal(container.querySelector('[aria-label="Disconnect https://site.example"]'), null)
    const copied: string[] = []
    Object.defineProperty(w.navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
    await React.act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Copy server address"]')!.click() })
    checks++; assert.deepEqual(copied, ['https://supermux.example'])
    const chromeCopy = [...container.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Copy chrome://extensions')!
    await React.act(async () => { chromeCopy.click() })
    checks++; assert.equal(copied.at(-1), 'chrome://extensions')
    // A same-kind member switch discards stale account state and late responses.
    let releaseOld: ((response: Response) => void) | undefined
    globalThis.fetch = (async () => new Promise<Response>(resolve => { releaseOld = resolve })) as typeof fetch
    await React.act(async () => { useViewer.setState({ viewer: { kind: 'member', companyId: 1, userId: 2, role: 'member', displayName: 'Second', email: 'second@example.com' } }) })
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: [{ id: 'new', origin: 'https://new-account.example', session: 'codex-demo', control_connected: true }] }), { status: 200 })) as typeof fetch
    await React.act(async () => { useViewer.setState({ viewer: { kind: 'member', companyId: 2, userId: 3, role: 'member', displayName: 'Third', email: 'third@example.com' } }) })
    await React.act(async () => { releaseOld!(new Response(JSON.stringify({ ok: true, data: [{ id: 'old', origin: 'https://old-account.example', session: 'codex-demo' }] }), { status: 200 })) })
    checks++; assert.ok(String(container.textContent).includes('https://new-account.example'))
    checks++; assert.ok(!String(container.textContent).includes('https://old-account.example'))
    checks++; assert.ok(!String(container.textContent).includes('https://site.example'))
    checks++; assert.equal(container.querySelector('[data-testid="browser-control-active"]')?.textContent, 'Control on')
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: [{ id: 'new', origin: 'https://new-account.example', session: 'codex-demo', control_connected: false }] }), { status: 200 })) as typeof fetch
    await React.act(async () => { w.dispatchEvent(new w.CustomEvent('supermux-browser-bindings-change', { detail: { session: 'codex-demo', source: 'other-panel' } })) })
    checks++; assert.equal(container.querySelector('[data-testid="browser-control-active"]'), null)
    checks++; assert.ok(String(container.textContent).includes('https://new-account.example'))
    // A company switch still uses the identical installation; policy errors
    // belong to agent access, rather than requiring a company-specific ZIP.
    checks++; assert.equal(container.querySelector('[data-testid="browser-extension-download"]')?.getAttribute('href'), '/downloads/supermux-browser-extension.zip')
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: false, error: 'conflict: agent workspace is outside its company isolation root' }), { status: 409 })) as typeof fetch
    const failedInput = container.querySelector<HTMLInputElement>('[data-testid="browser-pair-code"]')!
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value')!.set!.call(failedInput, '9012')
      failedInput.dispatchEvent(new w.Event('input', { bubbles: true }))
    })
    await React.act(async () => { failedInput.closest('form')!.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })) })
    checks++; assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('Ask an administrator to check its workspace access.'))
    checks++; assert.ok(!container.querySelector('[role="alert"]')?.textContent?.includes('isolation root'))
    checks++; assert.ok(container.querySelector('[role="alert"]')?.textContent?.includes('You don’t need a separate extension.'))
    checks++; assert.equal(failedInput.value, '9012')
    checks++; assert.equal(browserFeedbackError(new Error('The pairing code has expired.'), 'fallback'), 'The pairing code has expired.')
    checks++; assert.equal(browserFeedbackError(null, 'Could not pair.'), 'Could not pair.')
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, data: [] }), { status: 200 })) as typeof fetch
    await React.act(async () => { root.render(<BrowserFeedbackCard session="codex-demo" remote />) })
    checks++; assert.equal(container.querySelector<HTMLInputElement>('[data-testid="browser-pair-code"]')!.disabled, true)
    checks++; assert.ok(String(container.textContent).includes('SSH-hosted agents'))
    // Pending/anonymous viewers still receive the download, with no API calls.
    const before = calls.length
    await React.act(async () => { useViewer.setState({ viewer: { kind: 'pending' } }) })
    checks++; assert.notEqual(container.querySelector('[data-testid="browser-extension-download"]'), null)
    checks++; assert.equal(container.querySelector('[data-testid="browser-pair-code"]'), null)
    checks++; assert.equal(calls.length, before)
    w._SUPERMUX_BASE_URL = 'https://server.example/supermux'
    await React.act(async () => { root.render(<BrowserFeedbackCard session="codex-demo" />) })
    checks++; assert.equal(container.querySelector('[data-testid="browser-extension-download"]')?.getAttribute('href'), 'https://server.example/supermux/downloads/supermux-browser-extension.zip')
    checks++; assert.equal(supportsBrowserFeedback('claude'), true)
    checks++; assert.equal(supportsBrowserFeedback('codex'), true)
    checks++; assert.equal(supportsBrowserFeedback('shell'), false)
    checks++; assert.equal(supportsBrowserFeedback(undefined), false)
  } finally {
    await React.act(async () => { root.unmount(); await new Promise(resolve => setTimeout(resolve, 20)) })
    globalThis.fetch = oldFetch
    useViewer.setState({ viewer: oldViewer })
    dom.window.close()
    for (const [name, descriptor] of previousGlobals) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name) }
  }
}

await run()
console.log(`Browser feedback DOM fixture passed (${checks} assertions).`)
