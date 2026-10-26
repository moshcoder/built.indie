import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth, type Mail } from '../src/auth.ts'
import { coinpayOAuthFromEnv, placeholderEmail } from '../src/coinpay-signin.ts'
import { Store } from '../src/db.ts'
import { Media } from '../src/media.ts'
import { createApp } from '../src/server.ts'
import { BuiltIndie } from '../src/service.ts'

/** A fake CoinPay: the token endpoint hands out a token per code, userinfo says who it is. */
function fakeCoinPay(people: Record<string, { sub: string; email?: string; name?: string }>) {
  const seen: { url: string; body: string }[] = []
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const body = String(init?.body ?? '')
    seen.push({ url, body })
    if (url.endsWith('/api/oauth/token')) {
      const code = new URLSearchParams(body).get('code') ?? ''
      return people[code] ? Response.json({ access_token: `at-${code}`, token_type: 'Bearer' }) : Response.json({ error: 'invalid_grant' }, { status: 400 })
    }
    if (url.endsWith('/api/oauth/userinfo')) {
      const who = String((init?.headers as Record<string, string>)?.authorization ?? (init?.headers as Record<string, string>)?.Authorization ?? '').replace(/^Bearer at-/, '')
      return people[who] ? Response.json(people[who]) : new Response('no', { status: 401 })
    }
    return new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetch: f, seen }
}

function setup(people: Record<string, { sub: string; email?: string; name?: string }> = {}, on = true) {
  const dir = mkdtempSync(join(tmpdir(), 'builtindie-cp-'))
  const store = new Store(join(dir, 'test.db'), 'x'.repeat(32))
  const service = new BuiltIndie(store, new Media(join(dir, 'media')), { origin: 'https://built.indie.pit.world', coinpay: null, featureUsd: 19, featureDays: 7, screenshots: false })
  const mail: Mail[] = []
  const cp = fakeCoinPay(people)
  const app = createApp({ service, auth: new Auth(store, async (m) => void mail.push(m)), secureCookies: false, mailer: async (m) => void mail.push(m), coinpayOAuth: on ? { clientId: 'cp_test', clientSecret: 'shh', issuer: 'https://coinpayportal.com', fetch: cp.fetch } : null })
  const call = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://localhost${path}`, init), { ip: '1.2.3.4' })
  /** Start the flow; returns the state cookie and the state CoinPay would echo back. */
  const start = async (next = '', cookie = '') => {
    const r = await call(`/api/v1/coinpay/login${next ? `?next=${encodeURIComponent(next)}` : ''}`, cookie ? { headers: { cookie } } : {})
    const to = new URL(r.headers.get('location')!)
    const set = r.headers.get('set-cookie')!
    return { r, to, state: to.searchParams.get('state')!, cookie: set.split(';')[0]!, set }
  }
  const finish = (s: { state: string; cookie: string }, code: string, session = '') => call(`/api/v1/coinpay/callback?code=${code}&state=${s.state}`, { headers: { cookie: [s.cookie, session].filter(Boolean).join('; ') } })
  const sessionOf = (r: Response) => (r.headers.getSetCookie?.() ?? [r.headers.get('set-cookie') ?? '']).map((c) => c.split(';')[0]!).find((c) => c.startsWith('bi_session=') && c.length > 'bi_session='.length) ?? ''
  return { store, call, mail, cp, start, finish, sessionOf }
}

describe('Sign in with CoinPay', () => {
  test('login redirects to CoinPay authorize with PKCE S256; the state cookie is HttpOnly and scoped', async () => {
    const { start, call } = setup()
    const { r, to, set } = await start('/p/x')
    expect(r.status).toBe(302)
    expect(to.origin + to.pathname).toBe('https://coinpayportal.com/api/oauth/authorize')
    expect(to.searchParams.get('client_id')).toBe('cp_test')
    expect(to.searchParams.get('redirect_uri')).toBe('https://built.indie.pit.world/api/v1/coinpay/callback')
    expect(to.searchParams.get('code_challenge_method')).toBe('S256')
    expect(to.searchParams.get('code_challenge')).toBeTruthy()
    expect(set).toContain('HttpOnly')
    expect(set).toContain('Path=/api/v1/coinpay')
    // The button shows on /login.
    expect(await (await call('/login')).text()).toContain('Sign in with CoinPay')
  })

  test('a new CoinPay account becomes a member (display name from CoinPay, never its email); returning signs in again', async () => {
    const { start, finish, store, call, sessionOf, cp } = setup({ good: { sub: 'did:coinpay:abc', email: 'cara@example.com', name: 'Cara Coin' } })
    const s = await start('/leaderboard')
    const r = await finish(s, 'good')
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/leaderboard')
    const session = sessionOf(r)
    expect(session).toBeTruthy()
    const u = store.identityUser('coinpay', 'did:coinpay:abc')!
    expect(u.email).toBe(placeholderEmail('did:coinpay:abc'))
    expect(u.displayName).toBe('Cara Coin')
    expect(store.userByEmail('cara@example.com')).toBeNull()
    // The verifier went to the token endpoint.
    expect(cp.seen.find((x) => x.url.endsWith('/token'))!.body).toContain('code_verifier=')
    const me = await (await call('/me', { headers: { cookie: session } })).text()
    expect(me).toContain('Signed in with CoinPay as Cara Coin')
    expect(me).not.toContain('coinpay.invalid')
    // Next time: same member.
    const again = await finish(await start(), 'good')
    expect(store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 1 })
    expect(again.headers.get('location')).toBe('/me')
  })

  test('never merges by email: an address that already has an account is refused; that member connects from /me instead', async () => {
    const { start, finish, store, call, mail, sessionOf } = setup({ dup: { sub: 'did:coinpay:dup', email: 'ann@example.com', name: 'Not Ann' }, other: { sub: 'did:coinpay:other' } })
    const ann = store.findOrCreateUser('ann@example.com')
    const r = await finish(await start(), 'dup')
    expect(r.headers.get('location')).toBe('/login?error=coinpay-email-exists')
    expect(store.identityUser('coinpay', 'did:coinpay:dup')).toBeNull()
    expect(await (await call('/login?error=coinpay-email-exists')).text()).toContain('connect CoinPay')
    // Ann signs in by email and connects.
    await call('/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: 'email=ann%40example.com' })
    const token = mail.at(-1)!.text.match(/token=([\w-]+)/)![1]!
    const annSession = (await call(`/auth/verify?token=${token}`)).headers.get('set-cookie')!.split(';')[0]!
    expect(await (await call('/me', { headers: { cookie: annSession } })).text()).toContain('Connect CoinPay')
    const linked = await finish(await start('', annSession), 'dup', annSession)
    expect(linked.headers.get('location')).toBe('/me?coinpay=connected#signin')
    expect(store.identityUser('coinpay', 'did:coinpay:dup')!.id).toBe(ann.id)
    expect(sessionOf(linked)).toBe('')
    // A CoinPay account already linked elsewhere cannot be taken.
    const other = await finish(await start(), 'other')
    const otherSession = sessionOf(other)
    const taken = await finish(await start('', otherSession), 'dup', otherSession)
    expect(taken.headers.get('location')).toBe('/me?coinpay=taken#signin')
    expect(store.identityUser('coinpay', 'did:coinpay:dup')!.id).toBe(ann.id)
  })

  test('forged or stale callbacks are refused; off without a client', async () => {
    const { start, call, store } = setup({ good: { sub: 'did:coinpay:abc' } })
    const s = await start()
    expect((await call(`/api/v1/coinpay/callback?code=good&state=forged`, { headers: { cookie: s.cookie } })).headers.get('location')).toBe('/login?error=coinpay-state')
    expect((await call(`/api/v1/coinpay/callback?code=good&state=${s.state}`)).headers.get('location')).toBe('/login?error=coinpay-expired')
    expect((await call(`/api/v1/coinpay/callback?code=bad&state=${s.state}`, { headers: { cookie: s.cookie } })).headers.get('location')).toBe('/login?error=coinpay-failed')
    expect((await call(`/api/v1/coinpay/callback?error=access_denied&state=${s.state}`, { headers: { cookie: s.cookie } })).headers.get('location')).toBe('/login?error=coinpay-denied')
    expect(store.db.query('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 })
    const off = setup({}, false)
    expect((await off.call('/api/v1/coinpay/login')).headers.get('location')).toBe('/login?error=coinpay-off')
    expect(await (await off.call('/login')).text()).not.toContain('Sign in with CoinPay')
    expect(coinpayOAuthFromEnv({})).toBeNull()
    expect(coinpayOAuthFromEnv({ COINPAY_OAUTH_CLIENT_ID: 'a', COINPAY_OAUTH_CLIENT_SECRET: 'b' })).toMatchObject({ clientId: 'a', issuer: 'https://coinpayportal.com' })
  })
})
