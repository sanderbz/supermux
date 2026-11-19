/**
 * A MOCK remote-MCP + authorization server for the brokered sign-in e2e, plus the
 * public tunnel it has to sit behind.
 *
 * ── why a tunnel ──────────────────────────────────────────────────────────────
 * The broker's SSRF fence (`UrlPolicy`) admits https + a DNS name that resolves
 * PUBLICLY; `http://127.0.0.1:<port>` is refused, and the one relaxation
 * (`allow_loopback_http`) is an in-process test seam with deliberately no config
 * or env path — a separately-spawned binary cannot be told about it. A real
 * browser test therefore needs the mock to be genuinely public, which is what the
 * cloudflared QUICK TUNNEL gives us: one ephemeral `https://….trycloudflare.com`
 * in front of a loopback port, no account, no DNS.
 *
 * supermux itself stays on loopback, which is a TRUSTED OWNER TRANSPORT — so the
 * callback it registers (`http://127.0.0.1:<port>/api/oauth/callback`) is one the
 * browser can reach, and the whole journey stays on ONE origin (the pending
 * `state` lives in that origin's sessionStorage).
 *
 * The endpoints mirror `server/tests/oauth_code_e2e.rs`'s in-process mock, so the
 * two agree on what a conformant server looks like: RFC 9728 protected-resource
 * metadata → RFC 8414 AS metadata → RFC 7591 registration → PKCE code → token →
 * a REAL `tools/list` the probe counts.
 */
import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLOUDFLARED = join(homedir(), 'bin', 'cloudflared')
/** The identity the mock's userinfo hands back — asserted verbatim in the spec. */
export const MOCK_EMAIL = 'owner@mock.test'
/** How many tools the mock's `tools/list` returns — asserted verbatim. */
export const MOCK_TOOLS = ['echo', 'whoami']

export interface MockAs {
  /** The PUBLIC base (the quick tunnel), once `publish` has been called. */
  base: string
  /** The MCP endpoint the connector is registered with. */
  mcpUrl: string
  /** How many times an AUTHENTICATED `tools/list` ran (the probe). */
  toolsListCalls(): number
  /** How many client registrations the broker made. */
  registrations(): number
  stop(): Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers })
  res.end(s)
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function b64url(b: Buffer): string {
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * Start the mock on a loopback port. `base` is filled in by `publish()` once the
 * tunnel's public name is known — every metadata document is rendered from it, so
 * the issuer the broker validates is the name the browser will actually visit.
 */
export function startMockAs(port: number): { server: Server; state: MockState } {
  const state = new MockState()
  const server = createServer((req, res) => {
    void handle(req, res, state).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'mock_failure' })
    })
  })
  server.listen(port, '127.0.0.1')
  return { server, state }
}

export class MockState {
  base = ''
  clients = new Map<string, string>()
  codes = new Map<string, { challenge: string; redirectUri: string; resource: string }>()
  access = new Set<string>()
  refresh = new Set<string>()
  toolsList = 0
  registered = 0
  n = 0
}

async function handle(req: IncomingMessage, res: ServerResponse, g: MockState): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://mock.invalid')
  const path = url.pathname
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')

  // ── the remote MCP itself ──
  if (path === '/mcp' && req.method === 'POST') {
    if (!g.access.has(bearer)) {
      // RFC 9728 §5.1 challenge — where the broker's discovery starts.
      res.writeHead(401, {
        'www-authenticate': `Bearer resource_metadata="${g.base}/.well-known/oauth-protected-resource"`,
      })
      res.end()
      return
    }
    const body = await readBody(req)
    const method = (JSON.parse(body || '{}') as { method?: string }).method ?? ''
    if (method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    if (method === 'initialize') {
      json(res, 200, {
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'mock', version: '1' },
        },
      })
      return
    }
    if (method === 'tools/list') {
      g.toolsList += 1
      json(res, 200, {
        jsonrpc: '2.0',
        id: 2,
        result: { tools: MOCK_TOOLS.map((name) => ({ name, inputSchema: { type: 'object' } })) },
      })
      return
    }
    json(res, 200, { jsonrpc: '2.0', id: 0, error: { code: -32601, message: 'not implemented' } })
    return
  }

  // ── RFC 9728 protected-resource metadata ──
  if (path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp') {
    json(res, 200, {
      resource: `${g.base}/mcp`,
      authorization_servers: [g.base],
      scopes_supported: ['mcp:tools'],
    })
    return
  }

  // ── RFC 8414 AS metadata ──
  if (path === '/.well-known/oauth-authorization-server') {
    json(res, 200, {
      issuer: g.base,
      authorization_endpoint: `${g.base}/authorize`,
      token_endpoint: `${g.base}/token`,
      registration_endpoint: `${g.base}/register`,
      userinfo_endpoint: `${g.base}/userinfo`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      authorization_response_iss_parameter_supported: true,
    })
    return
  }

  // ── RFC 7591 dynamic client registration ──
  if (path === '/register' && req.method === 'POST') {
    await readBody(req)
    g.n += 1
    g.registered += 1
    const id = `client-${g.n}`
    const secret = `secret-${g.n}`
    g.clients.set(id, secret)
    json(res, 201, { client_id: id, client_secret: secret })
    return
  }

  // ── the consent page. Auto-approving on purpose: this test is about what
  //    supermux does with the ANSWER, not about clicking someone else's button. ──
  if (path === '/authorize') {
    const q = url.searchParams
    const code = `code-${randomBytes(6).toString('hex')}`
    g.codes.set(code, {
      challenge: q.get('code_challenge') ?? '',
      redirectUri: q.get('redirect_uri') ?? '',
      resource: q.get('resource') ?? '',
    })
    const loc = `${q.get('redirect_uri')}?code=${encodeURIComponent(code)}&state=${encodeURIComponent(
      q.get('state') ?? '',
    )}&iss=${encodeURIComponent(g.base)}`
    res.writeHead(302, { location: loc })
    res.end()
    return
  }

  // ── the token endpoint (PKCE S256 verified, like the real one) ──
  if (path === '/token' && req.method === 'POST') {
    const form = new URLSearchParams(await readBody(req))
    const clientId = form.get('client_id') ?? ''
    if (g.clients.get(clientId) !== form.get('client_secret')) {
      json(res, 401, { error: 'invalid_client' })
      return
    }
    if (form.get('grant_type') === 'refresh_token') {
      json(res, 200, mint(g))
      return
    }
    const rec = g.codes.get(form.get('code') ?? '')
    if (!rec) {
      json(res, 401, { error: 'invalid_grant' })
      return
    }
    g.codes.delete(form.get('code') ?? '')
    const verifier = form.get('code_verifier') ?? ''
    if (b64url(createHash('sha256').update(verifier).digest()) !== rec.challenge) {
      json(res, 400, { error: 'invalid_grant' })
      return
    }
    if (form.get('redirect_uri') !== rec.redirectUri) {
      json(res, 400, { error: 'invalid_grant' })
      return
    }
    json(res, 200, mint(g))
    return
  }

  // ── the identity the account is labelled with ──
  if (path === '/userinfo') {
    if (!g.access.has(bearer)) {
      res.writeHead(401)
      res.end()
      return
    }
    json(res, 200, { email: MOCK_EMAIL, sub: 'u1' })
    return
  }

  res.writeHead(404)
  res.end()
}

function mint(g: MockState): Record<string, unknown> {
  g.n += 1
  const at = `at-${g.n}-${randomBytes(4).toString('hex')}`
  const rt = `rt-${g.n}-${randomBytes(4).toString('hex')}`
  g.access.add(at)
  g.refresh.add(rt)
  return { access_token: at, token_type: 'Bearer', expires_in: 3600, refresh_token: rt, scope: 'mcp:tools' }
}

/**
 * Put a cloudflared QUICK TUNNEL in front of `port` and resolve its public https
 * name. Resolves `null` when cloudflared is missing or never gets a tunnel up —
 * the spec then SKIPS rather than failing, because "no outbound tunnel today" is
 * an environment fact, not a regression in the product.
 *
 * BOTH signals are waited for: the announced `https://….trycloudflare.com` name
 * AND a `Registered tunnel connection` line. cloudflared prints them in either
 * order, and the name exists in DNS only once a connection is registered — so
 * resolving on the name alone means the first probe can hit NXDOMAIN, which some
 * runtimes negative-cache for the rest of the process. That is exactly how this
 * helper first failed: a URL at 6 s, then sixty seconds of `ConnectionRefused`
 * against a tunnel that was in fact serving.
 *
 * The stderr pipe is drained the whole time: cloudflared keeps logging, and a
 * full pipe would wedge the process mid-test.
 */
export async function openQuickTunnel(
  port: number,
  timeoutMs = 90_000,
): Promise<{ url: string; proc: ChildProcess } | null> {
  if (!existsSync(CLOUDFLARED)) return null
  const proc = spawn(CLOUDFLARED, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let seen = ''
  let url: string | null = null
  let registered = false
  let settle: ((u: string | null) => void) | null = null
  const done = new Promise<string | null>((r) => (settle = r))
  const finish = (u: string | null) => {
    const r = settle
    if (!r) return
    settle = null
    r(u)
  }
  const scan = (chunk: Buffer) => {
    seen += chunk.toString('utf8')
    url ??= /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(seen)?.[0] ?? null
    registered ||= /Registered tunnel connection/i.test(seen)
    if (url && registered) finish(url)
    // Keep the buffer bounded — this process logs for the whole test.
    if (seen.length > 64_000) seen = seen.slice(-8_000)
  }
  proc.stderr?.on('data', scan)
  proc.stdout?.on('data', scan)
  proc.on('exit', () => finish(null))

  const timer = setTimeout(() => finish(null), timeoutMs)
  const got = await done
  clearTimeout(timer)
  if (!got) {
    proc.kill('SIGTERM')
    return null
  }
  return { url: got, proc }
}

/** Poll the tunnel until it really serves the mock (edge propagation is not
 *  instant), or give up. `true` when it answered. */
export async function tunnelReady(base: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // The edge needs a beat after registration, and the tunnel's hostname needs a
  // beat more to be resolvable. Probing instantly is what invites a DNS MISS that
  // some runtimes negative-cache for far longer than this whole poll window —
  // measured: a first probe at ~2 s failed for the next sixty seconds against a
  // tunnel that was serving fine, while a first probe at ~5 s answered 200.
  await new Promise((r) => setTimeout(r, 6_000))
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/.well-known/oauth-protected-resource`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (r.ok) {
        const body = (await r.json()) as { resource?: string }
        if (typeof body.resource === 'string') return true
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return false
}
