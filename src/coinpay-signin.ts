/**
 * Sign in with CoinPay: the house identity provider (OIDC at coinpayportal.com,
 * authorization code + PKCE S256), through the shared @profullstack/stack/coinpay
 * helpers. Same flow as pwamart.com, so one CoinPay account is a member of both.
 *
 * Linking is by CoinPay `sub` only (user_identities), never by email: CoinPay
 * does not verify emails (email_verified is always false). So:
 *   - a returning sub signs in as the member it is linked to;
 *   - a signed-in member who connects (from /me) gets the sub attached;
 *   - anyone else gets a new member, with their CoinPay name as the display name
 *     and a placeholder address (…@coinpay.invalid): the CoinPay email is never
 *     used as the account's email, or it would let a CoinPay account sign in as
 *     whoever owns that address here. An address that already has an account
 *     is refused: that person signs in by email and connects CoinPay from /me.
 *
 * The state and PKCE verifier ride in a short HttpOnly cookie scoped to
 * /api/v1/coinpay. Off (buttons hidden, routes redirect) without a client id and secret.
 */
import { createHash, randomBytes } from 'node:crypto'
import { exchangeCoinPayCode, fetchCoinPayUserinfo, generateCoinPayPkcePair, getCoinPayAuthorizeUrl, validateCoinPayState } from '@profullstack/stack/coinpay'
import type { Context, Hono } from 'hono'
import { getCookie, setCookie } from 'hono/cookie'
import { safeNext, SESSION_COOKIE, type Auth } from './auth.js'
import type { Store, User } from './db.js'

export type CoinPayOAuth = { clientId: string; clientSecret: string; issuer: string; /** Tests pass a fake CoinPay. */ fetch?: typeof fetch }

export const PROVIDER = 'coinpay'
const COOKIE = 'bi_cp'
const PATH = '/api/v1/coinpay'
const SCOPES = 'openid profile email'

export function coinpayOAuthFromEnv(env: Record<string, string | undefined> = process.env): CoinPayOAuth | null {
  const clientId = env.COINPAY_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.COINPAY_OAUTH_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret, issuer: (env.COINPAY_OAUTH_ISSUER ?? 'https://coinpayportal.com').replace(/\/+$/, '') } : null
}

/** The address a CoinPay-only member is kept under: unique, and never deliverable. */
export const placeholderEmail = (sub: string) => `cp-${createHash('sha256').update(sub).digest('hex').slice(0, 20)}@coinpay.invalid`
export const isPlaceholder = (email: string) => email.endsWith('@coinpay.invalid')

export function mountCoinPaySignin(
  app: Hono<any>,
  o: { store: Store; auth: Auth; origin: string; oauth: CoinPayOAuth | null; secure: (c: Context) => boolean; sessionUser: (c: Context) => User | null; onNewMember?: (c: Context, user: User) => void },
): void {
  const redirectUri = `${o.origin}${PATH}/callback`
  const cookie = (c: Context, value: string, maxAge: number) => setCookie(c, COOKIE, value, { httpOnly: true, secure: o.secure(c), sameSite: 'Lax', path: PATH, maxAge })

  app.get(`${PATH}/login`, (c) => {
    if (!o.oauth) return c.redirect('/login?error=coinpay-off')
    const state = randomBytes(24).toString('base64url')
    const { codeVerifier, codeChallenge } = generateCoinPayPkcePair()
    const next = safeNext(c.req.query('next')) ?? '/me'
    cookie(c, Buffer.from(JSON.stringify({ state, codeVerifier, next })).toString('base64url'), 600)
    return c.redirect(getCoinPayAuthorizeUrl({ issuer: o.oauth.issuer, clientId: o.oauth.clientId, redirectUri, state, codeChallenge, scopes: SCOPES }))
  })

  app.get(`${PATH}/callback`, async (c) => {
    const fail = (why: string) => c.redirect(`/login?error=${encodeURIComponent(why)}`)
    if (!o.oauth) return fail('coinpay-off')
    let saved: { state?: string; codeVerifier?: string; next?: string } | null = null
    try {
      saved = JSON.parse(Buffer.from(getCookie(c, COOKIE) ?? '', 'base64url').toString())
    } catch {}
    cookie(c, '', 0)
    if (!saved?.state || !saved.codeVerifier) return fail('coinpay-expired')
    if (c.req.query('error')) return fail('coinpay-denied')
    if (!validateCoinPayState(c.req.query('state'), saved.state)) return fail('coinpay-state')
    const code = c.req.query('code')
    if (!code) return fail('coinpay-failed')

    let claims: { sub?: string; email?: string; name?: string }
    try {
      const tokens = await exchangeCoinPayCode({ issuer: o.oauth.issuer, code, redirectUri, clientId: o.oauth.clientId, clientSecret: o.oauth.clientSecret, codeVerifier: saved.codeVerifier, fetch: o.oauth.fetch })
      claims = await fetchCoinPayUserinfo({ issuer: o.oauth.issuer, accessToken: tokens.access_token, fetch: o.oauth.fetch })
    } catch (e) {
      console.error(`[coinpay-signin] ${(e as Error).message}`)
      return fail('coinpay-failed')
    }
    const sub = String(claims.sub ?? '')
    if (!sub) return fail('coinpay-failed')
    const email = String(claims.email ?? '').trim().toLowerCase() || null
    const name = String(claims.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || null
    const next = safeNext(saved.next) ?? '/me'

    // Connecting CoinPay to the member who is signed in.
    const current = o.sessionUser(c)
    if (current) {
      if (!o.store.linkIdentity({ provider: PROVIDER, subject: sub, userId: current.id, email, name })) return c.redirect('/me?coinpay=taken#signin')
      return c.redirect('/me?coinpay=connected#signin')
    }

    let user = o.store.identityUser(PROVIDER, sub)
    let created = false
    if (!user) {
      if (email && o.store.userByEmail(email)) return fail('coinpay-email-exists')
      user = o.store.findOrCreateUser(placeholderEmail(sub))
      created = true
      o.store.linkIdentity({ provider: PROVIDER, subject: sub, userId: user.id, email, name })
      if (name && !user.displayName) o.store.setDisplayName(user.id, name)
      user = o.store.user(user.id)!
      o.onNewMember?.(c, user)
    }
    setCookie(c, SESSION_COOKIE, o.auth.createSession(user.id), { httpOnly: true, secure: o.secure(c), sameSite: 'Lax', path: '/', maxAge: 90 * 86400 })
    return c.redirect(created && next === '/me' ? '/me?coinpay=welcome' : next)
  })
}

/** What /login says for each ?error= the flow can end with. */
export const COINPAY_ERRORS: Record<string, string> = {
  'coinpay-off': 'Sign in with CoinPay is not set up on this server. Use your email instead.',
  'coinpay-expired': 'That CoinPay sign-in took too long. Try again.',
  'coinpay-denied': 'CoinPay sign-in was cancelled.',
  'coinpay-state': 'That CoinPay sign-in did not match this browser. Try again.',
  'coinpay-failed': 'CoinPay did not confirm who you are. Try again in a moment.',
  'coinpay-email-exists': 'That email already has a built.indie account. Sign in with your email, then connect CoinPay on your page.',
}
