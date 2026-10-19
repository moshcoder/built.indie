/**
 * The built.indie web server: pages, the JSON API, badges, pictures, feeds,
 * the OpenSite/OpenProfile documents and CoinPay's webhook.
 *
 * built.indie is a Moshpit name. Visitors on Moshpit DNS reach https://built.indie
 * directly; everyone else comes through the pit.world relay at
 * https://built.indie.pit.world, which is the address we hand out (badges,
 * share links, feeds) because it works for everybody.
 */
import { startRingFooterRefresh } from './ring-footer.js'
import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { leaderboard } from '@profullstack/leaderboard/hono'
import { Auth, consoleMailer, resendMailer, safeNext, SESSION_COOKIE, validEmail, type Mailer } from './auth.js'
import { Store, type Product, type User, type Window } from './db.js'
import { privateAddress } from './fetch.js'
import { badgeSvg, boardPage, cardImage, claimBadgeSnippet, claimMarkdown, claimPage, editPage, esc, helpPage, homePage, inviteLanding, invitePage, leaderboardPage, loginPage, makerPage, mePage, messagePage, productPage, submitPage, type Ctx, type InviterRow } from './html.js'
import { inviteLeaderboard } from './leaderboard.js'
import { IMAGE_TYPES, Media } from './media.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { BuiltIndie, CLAIM_LABEL, CLAIM_PREFIX, DEFAULT_CHAINS, InputError, type Config, type Edit } from './service.js'
import { autofetch, FetchError } from './fetch.js'
import { VERSION } from './version.js'

export { VERSION }

const SELF = 'built.indie'
export const PUBLIC_ORIGIN = 'https://built.indie.pit.world'

const CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://crawlproof.com",
  "img-src 'self' data:",
  "connect-src 'self' https://crawlproof.com",
  'frame-src https://crawlproof.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com',
  "manifest-src 'self'",
  "worker-src 'self'",
  "form-action 'self' https://coinpayportal.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ')

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy': CSP,
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'interest-cohort=(), browsing-topics=(), camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
}

export type Deps = { service: BuiltIndie; auth: Auth; adminKey?: string; secureCookies?: boolean; mailer?: Mailer }

/** The invite code from /i/<code>, kept until the visitor signs up (it also rides in the magic link). */
const REF_COOKIE = 'bi_ref'
type Env = { Bindings: { ip?: string } }

/** A small fixed-window limit per key, in memory: enough to stop a loop, not a fortress. */
class Limiter {
  private hits = new Map<string, { n: number; reset: number }>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const h = this.hits.get(key)
    if (!h || h.reset < now) {
      if (this.hits.size > 50_000) this.hits.clear()
      this.hits.set(key, { n: 1, reset: now + this.windowMs })
      return true
    }
    h.n += 1
    return h.n <= this.max
  }
}

const WINDOWS: Window[] = ['today', 'week', 'month', 'all', 'new', 'featured']

export function createApp(deps: Deps) {
  const { service } = deps
  const store = service.store
  const config = service.config
  const app = new Hono<Env>()
  const readLimit = new Limiter(20, 10 * 60_000)
  const voteLimit = new Limiter(60, 10 * 60_000)
  const origin = config.origin

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  const ip = (c: Context<Env>) => c.env?.ip ?? 'local'
  const voter = (c: Context<Env>) => store.voterFor(ip(c))
  const sessionUser = (c: Context) => deps.auth.sessionUser(getCookie(c, SESSION_COOKIE))
  const ctxOf = (c: Context<Env>): Ctx => {
    const v = voter(c)
    return { origin, user: sessionUser(c), voted: (id) => store.voted(id, v) }
  }
  // Links in mail open where the visitor asked from: the relay, or the Moshpit name itself.
  const here = (c: Context) => (direct(c) ? 'https://built.indie' : origin)
  const toLogin = (c: Context) => c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`)
  const page = (c: Context, html: string, status = 200) => c.html(html.replace(RING_PLACEHOLDER, ringBar(SELF, direct(c))), status as 200)
  const wantsJson = (c: Context) => (c.req.header('accept') ?? '').includes('application/json')
  // Form posts from another site are refused: a page elsewhere cannot vote with our visitors' addresses.
  const crossSite = (c: Context) => {
    const s = c.req.header('sec-fetch-site')
    return s !== undefined && s !== 'same-origin' && s !== 'none'
  }
  const bearer = (c: Context) => (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  const isAdmin = (c: Context) => Boolean(deps.adminKey && deps.adminKey.length >= 16 && bearer(c) === deps.adminKey)
  const live = (slug: string) => {
    const p = store.bySlug(slug)
    return p?.status === 'live' ? p : null
  }
  const secure = (c: Context) => deps.secureCookies ?? (c.req.header('x-forwarded-proto') ?? 'https') === 'https'

  // The invite program and its leaderboard (@profullstack/leaderboard over the invites table).
  const board = inviteLeaderboard(store, origin)
  const inviters = async (limit: number): Promise<InviterRow[]> => (await board.top({ board: 'invites', period: 'week', limit })).rows.map((r) => ({ ...r, url: `/leaderboard/u/${encodeURIComponent(r.id)}` }))
  const inviteLink = (user: User) => `${origin}/i/${store.inviteCode(user.id)}`
  service.onInviteEarned = (inviterId, p) => {
    board.invalidate()
    // A projection is never record()ed, so badges are checked here, when the fact they rest on changes.
    board.award(inviterId).catch((e) => console.error(`[invite] badges: ${(e as Error).message}`))
    const inviter = store.user(inviterId)
    if (!inviter || !deps.mailer) return
    const credits = store.inviteStats(inviterId).credits
    const text = `${p.name} just launched on built.indie through your invite: ${origin}/p/${p.slug}\n\nThat earned you a free Featured week. You have ${credits} to use: ${origin}/invite\n\nKeep going: every maker you invite who launches earns another.`
    const html = `<p><b>${esc(p.name)}</b> just launched on built.indie through your invite: <a href="${origin}/p/${esc(p.slug)}">${origin}/p/${esc(p.slug)}</a></p><p>That earned you a free Featured week. You have <b>${credits}</b> to use.</p><p><a href="${origin}/invite" style="display:inline-block;padding:10px 18px;background:#ff5c39;color:#fff;border-radius:8px;text-decoration:none;font-weight:700">Use it</a></p>`
    deps.mailer({ to: inviter.email, subject: `You earned a free Featured week on built.indie`, text, html }).catch((e) => console.error(`[invite] mail failed: ${(e as Error).message}`))
  }

  app.use('*', async (c, next) => {
    await next()
    if (!c.res.headers.has('content-security-policy')) for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v)
  })

  app.get('/health', (c) => c.json({ ok: true, version: VERSION }))

  // Static files.
  const TYPES: Record<string, string> = { css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', crt: 'application/x-x509-ca-cert', webmanifest: 'application/manifest+json' }
  app.get('/:file{(style\\.css|app\\.js|sw\\.js|favicon\\.svg|icon-192\\.png|icon-512\\.png|manifest\\.webmanifest|moshpit-root-ca\\.crt)}', async (c) => {
    const name = c.req.param('file')
    const file = Bun.file(new URL(`../public/${name}`, import.meta.url))
    const fresh = name === 'sw.js' || name === 'manifest.webmanifest'
    return c.body(await file.arrayBuffer(), 200, { 'content-type': TYPES[name.split('.').pop()!]!, 'cache-control': fresh ? 'no-cache' : 'public, max-age=86400' })
  })

  // The CLI installer: curl -fsSL https://built.indie.pit.world/install.sh | sh
  app.get('/install.sh', async (c) => c.body(await Bun.file(new URL('../public/install.sh', import.meta.url)).text(), 200, { 'content-type': 'text/x-sh; charset=utf-8', 'cache-control': 'public, max-age=300' }))

  // Our icons: the OpenIcon reference set, the part we draw (logicsrc.com/docs/openicon).
  app.get('/icons/openicon.json', async (c) => c.body(await Bun.file(new URL('../public/icons/openicon.json', import.meta.url)).text(), 200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' }))
  app.get('/icons/svg/:file{[a-z0-9-]+\\.svg}', async (c) => {
    const file = Bun.file(new URL(`../public/icons/svg/${c.req.param('file')}`, import.meta.url))
    return (await file.exists()) ? c.body(await file.text(), 200, { 'content-type': 'image/svg+xml', 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=86400' }) : c.notFound()
  })
  app.get('/.well-known/openicon.json', (c) => c.json({ openicon: '0.1', sets: [{ name: 'OpenIcon (built.indie subset)', url: `${origin}/icons/openicon.json` }] }, 200, { 'access-control-allow-origin': '*' }))
  app.get('/.well-known/openstack.md', async (c) => c.body(await Bun.file(new URL('../OpenStack.md', import.meta.url)).text(), 200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }))

  // Boards.
  app.get('/', async (c) =>
    page(c, homePage(ctxOf(c), { today: store.list('today'), featured: store.list('featured', 3), yesterday: store.onDay(new Date(Date.now() - 86400_000).toISOString().slice(0, 10), 3), stats: store.count(), inviters: await inviters(5), featureDays: config.featureDays, featureUsd: config.featureUsd })),
  )
  app.get('/top/:window', (c) => {
    const w = c.req.param('window') as Window
    if (!WINDOWS.includes(w)) return c.notFound()
    return page(c, boardPage(ctxOf(c), w, store.list(w, 50)))
  })
  app.get('/new', (c) => page(c, boardPage(ctxOf(c), 'new', store.list('new', 50))))
  app.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').trim().slice(0, 60)
    return q ? page(c, boardPage(ctxOf(c), 'all', store.search(q), q)) : c.redirect('/top/all')
  })
  app.get('/help', (c) => page(c, helpPage(ctxOf(c))))

  // Launching.
  app.get('/submit', (c) => page(c, submitPage(ctxOf(c), { values: { url: c.req.query('url') ?? '' } })))
  app.post('/submit', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>
    if (crossSite(c)) return page(c, submitPage(ctxOf(c), { values: form, error: { message: 'Launch from this site, please.' } }), 403)
    if (!readLimit.allow(`read:${ip(c)}`)) return page(c, submitPage(ctxOf(c), { values: form, error: { message: 'Too many launches from you. Wait a few minutes.' } }), 429)
    try {
      const user = sessionUser(c)
      const r = await service.submit({ url: form.url ?? '', makerName: form.makerName, makerProfile: form.makerProfile }, store.voterFor(ip(c)), user)
      if (r.existing) return c.redirect(`/p/${r.product.slug}?existing=1`)
      return c.redirect(user ? `/p/${r.product.slug}/edit?fresh=1` : `/p/${r.product.slug}?launched=1`)
    } catch (e) {
      if (!(e instanceof InputError)) console.error('submit', e)
      return page(c, submitPage(ctxOf(c), { values: form, error: { message: e instanceof Error ? e.message : String(e), ...(e instanceof InputError && e.field ? { field: e.field } : {}) } }), e instanceof InputError ? 400 : 502)
    }
  })

  // A product.
  const productView = (c: Context<Env>, p: Product) =>
    page(
      c,
      productPage(ctxOf(c), {
        product: p,
        award: store.awards(p.id),
        maker: p.makerId ? store.maker(p.makerId) : null,
        featuredOk: c.req.query('featured') === '1',
        featuredCredit: c.req.query('featured') === 'credit',
        launched: c.req.query('launched') === '1',
        canEdit: store.canEdit(p, sessionUser(c)),
        credits: (() => {
          const u = sessionUser(c)
          return u && store.canEdit(p, u) ? store.inviteStats(u.id).credits : 0
        })(),
        chains: config.chains,
        featureUsd: config.featureUsd,
        featureDays: config.featureDays,
        payments: Boolean(config.coinpay),
      }),
    )
  app.get('/p/:slug', (c) => {
    const p = store.bySlug(c.req.param('slug'))
    // A draft is visible to whoever may edit it (the preview); otherwise it does not exist yet.
    if (!p || p.status === 'hidden' || (p.status === 'draft' && !store.canEdit(p, sessionUser(c)))) return page(c, messagePage(ctxOf(c), { title: 'Not here', message: 'Nothing has launched at that address.' }), 404)
    return productView(c, p)
  })

  const editView = (c: Context<Env>, p: Product, extra: { flash?: string; error?: { message: string; field?: string } } = {}, status = 200) =>
    page(c, editPage(ctxOf(c), { product: p, fresh: c.req.query('fresh') === '1', ...extra }), status)
  /** The product, when the signed-in person may edit it; otherwise the response to send. */
  const editable = (c: Context<Env>): Product | Response => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug') ?? '')
    if (!p || p.status === 'hidden') return page(c, messagePage(ctxOf(c), { title: 'Not here', message: 'Nothing has launched at that address.' }), 404)
    if (!store.canEdit(p, user)) return c.redirect(`/p/${p.slug}/claim`)
    return p
  }
  app.get('/p/:slug/edit', (c) => {
    const p = editable(c)
    return p instanceof Response ? p : editView(c, p)
  })
  app.post('/p/:slug/edit', async (c) => {
    const p = editable(c)
    if (p instanceof Response) return p
    if (crossSite(c)) return editView(c, p, { error: { message: 'Edit from built.indie itself.' } }, 403)
    const body = await c.req.parseBody({ all: true })
    const one = (k: string) => (Array.isArray(body[k]) ? String((body[k] as unknown[])[0]) : body[k] === undefined ? undefined : String(body[k]))
    const action = one('action') ?? 'save'
    try {
      if (action === 'delete') {
        store.delete(p.id)
        await service.media.remove(p.id)
        return page(c, messagePage(ctxOf(c), { title: 'Deleted', message: `${p.name} is gone, pictures and all.` }))
      }
      if (action === 'refetch') {
        if (!readLimit.allow(`read:${ip(c)}`)) return editView(c, p, { error: { message: 'Too many reads from you. Wait a few minutes.' } }, 429)
        return editView(c, await service.refetch(p), { flash: 'Read your homepage again.' })
      }
      const remove = body.remove === undefined ? [] : (Array.isArray(body.remove) ? body.remove : [body.remove]).map(String)
      const edit: Edit = { name: one('name'), tagline: one('tagline'), description: one('description'), tags: one('tags'), videos: one('videos'), makerName: one('makerName'), makerProfile: one('makerProfile'), remove }
      let updated = await service.edit(p, edit)
      if (action === 'publish') {
        updated = service.publish(updated)
        return c.redirect(`/p/${updated.slug}?launched=1`)
      }
      return editView(c, updated, { flash: 'Saved.' })
    } catch (e) {
      if (!(e instanceof InputError)) console.error('edit', e)
      return editView(c, store.product(p.id) ?? p, { error: { message: e instanceof Error ? e.message : String(e), ...(e instanceof InputError && e.field ? { field: e.field } : {}) } }, e instanceof InputError ? 400 : 502)
    }
  })

  // Claiming: the domain's owner proves it with the badge carrying their badge id, or in DNS, and takes the listing.
  const claimRecord = (p: Product, user: User) => ({ type: 'TXT', name: `${CLAIM_LABEL}.${p.domain.replace(/^www\./, '')}`, value: `${CLAIM_PREFIX}${service.claimToken(p, user)}` })
  const claimBadge = (p: Product, user: User) => claimBadgeSnippet(origin, p, store.badgeId(p.id, user.id))
  const claimMd = (p: Product, user: User) => claimMarkdown(origin, p, claimRecord(p, user), claimBadge(p, user))
  const claimView = (c: Context<Env>, p: Product, user: User, extra: { result?: { ok: boolean; looked: string[]; method?: string } } = {}, status = 200) =>
    page(c, claimPage(ctxOf(c), { product: p, record: claimRecord(p, user), badge: claimBadge(p, user), owner: p.ownerId === user.id, ...extra }), status)
  // The same instructions as Markdown, to paste to an AI agent with DNS access.
  app.get('/p/:slug/claim.md', (c) => {
    const user = sessionUser(c)
    if (!user) return c.redirect(`/login?next=${encodeURIComponent(c.req.path)}`)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.text('not found', 404)
    return c.body(claimMd(p, user), 200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'private, no-store' })
  })
  app.get('/p/:slug/claim', (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.notFound()
    return claimView(c, p, user)
  })
  app.post('/p/:slug/claim', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.notFound()
    if (crossSite(c) || !readLimit.allow(`read:${ip(c)}`)) return claimView(c, p, user, {}, 429)
    const result = await service.claim(p, user)
    return claimView(c, store.product(p.id)!, user, { result })
  })

  // Signing in: an emailed link, which is also sign-up.
  const invitedBy = (c: Context) => {
    const inviter = store.inviterOf(getCookie(c, REF_COOKIE) ?? '')
    return inviter && !sessionUser(c) ? store.publicName(inviter) : null
  }
  app.get('/login', (c) => page(c, loginPage(ctxOf(c), { next: safeNext(c.req.query('next')), invitedBy: invitedBy(c) })))
  app.post('/login', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>
    const next = safeNext(form.next)
    if (!validEmail(form.email)) return page(c, loginPage(ctxOf(c), { next, error: 'That does not look like an email address.', email: form.email }), 400)
    if (!crossSite(c) && readLimit.allow(`mail:${ip(c)}`)) await deps.auth.sendLink(form.email ?? '', next, here(c), getCookie(c, REF_COOKIE) ?? null)
    return page(c, loginPage(ctxOf(c), { next, sent: true }))
  })
  app.get('/auth/verify', (c) => {
    const r = deps.auth.consumeLink(c.req.query('token') ?? '')
    if (!r) return page(c, messagePage(ctxOf(c), { title: 'That link is used up', message: 'Sign-in links work once, for 20 minutes. Ask for a new one.' }), 400)
    setCookie(c, SESSION_COOKIE, deps.auth.createSession(r.user.id), { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 90 * 86400 })
    // A new member who came through an invite link: their first live listing will earn the inviter a credit.
    const ref = r.ref ?? getCookie(c, REF_COOKIE)
    if (r.created && ref) store.recordInvite(r.user.id, ref)
    if (ref) deleteCookie(c, REF_COOKIE, { path: '/' })
    return c.redirect(r.next ?? '/me')
  })
  app.post('/logout', (c) => {
    if (!crossSite(c)) deps.auth.endSession(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect('/')
  })
  app.get('/me', (c) => {
    const user = sessionUser(c)
    return user ? page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), invite: store.inviteStats(user.id) })) : toLogin(c)
  })
  app.post('/me/key', (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/me')
    return page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), apiKey: store.newApiKey(user.id), invite: store.inviteStats(user.id) }))
  })

  // Invites: a link per member; a new member it brings in who launches earns the inviter a free Featured week.
  app.get('/i/:code', (c) => {
    const code = c.req.param('code')
    const inviter = store.inviterOf(code)
    if (!inviter) return c.redirect('/invite')
    if (!sessionUser(c)) setCookie(c, REF_COOKIE, code, { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
    return page(c, inviteLanding(ctxOf(c), { inviter: store.publicName(inviter) }))
  })
  const inviteView = async (c: Context<Env>, extra: { flash?: string; error?: string } = {}, status = 200) => {
    const user = sessionUser(c)
    const me = user
      ? { link: inviteLink(user), stats: store.inviteStats(user.id), name: store.publicName(user.id), displayName: user.displayName, listings: store.mine(user.id).filter((p) => p.status === 'live'), ...extra }
      : undefined
    return page(c, invitePage(ctxOf(c), { featureDays: config.featureDays, featureUsd: config.featureUsd, inviters: await inviters(10), me }), status)
  }
  app.get('/invite', (c) => inviteView(c))
  app.post('/invite/name', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/invite')
    const name = String(((await c.req.parseBody()) as Record<string, string>).displayName ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    store.setDisplayName(user.id, name || null)
    board.invalidate()
    return inviteView(c, { flash: name ? `Saved. The board shows you as ${name}.` : 'Cleared. The board shows your best listing instead.' })
  })
  app.post('/p/:slug/credit', (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.notFound()
    if (crossSite(c) || !store.canEdit(p, user)) return c.redirect(`/p/${p.slug}`)
    try {
      service.redeemCredit(p, user)
      return c.redirect(`/p/${p.slug}?featured=credit`)
    } catch (e) {
      return inviteView(c, { error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })

  // The leaderboard: our page, then the package answers everything under /leaderboard (JSON, RSS, share cards, widget).
  app.get('/leaderboard', (c) => {
    const user = sessionUser(c)
    return page(c, leaderboardPage(ctxOf(c), { featureDays: config.featureDays, featureUsd: config.featureUsd, me: user?.id ?? null }))
  })
  app.use('/leaderboard.json', leaderboard(board))
  app.use('/leaderboard/*', leaderboard(board))

  app.post('/p/:slug/vote', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return wantsJson(c) ? c.json({ error: 'no such product' }, 404) : c.notFound()
    if (crossSite(c)) return c.json({ error: 'vote from built.indie itself' }, 403)
    const counted = voteLimit.allow(`vote:${ip(c)}`) && store.vote(p.id, voter(c))
    const now = store.product(p.id)!
    if (wantsJson(c)) return c.json({ slug: now.slug, votes: now.votes, counted, voted: true })
    const back = c.req.header('referer')
    let to = `/p/${p.slug}`
    try {
      if (back && new URL(back).host === c.req.header('host')) to = new URL(back).pathname
    } catch {}
    return c.redirect(to)
  })

  app.post('/p/:slug/verify', async (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.notFound()
    if (!readLimit.allow(`read:${ip(c)}`)) return c.redirect(`/p/${p.slug}#badge`)
    const ok = await service.verify(p)
    return page(c, messagePage(ctxOf(c), ok ? { title: 'Verified ✓', message: `We found the badge on ${p.domain}. Your link here is now a followed link.` } : { title: 'Not yet', message: `We read ${p.domain} and did not find a link to built.indie. Add the badge HTML to your homepage, deploy, and try again.` }))
  })

  app.post('/p/:slug/feature', async (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.notFound()
    const form = (await c.req.parseBody()) as Record<string, string>
    try {
      const r = await service.feature(p, form.chain ?? '')
      return c.redirect(r.checkoutUrl)
    } catch (e) {
      return page(c, messagePage(ctxOf(c), { title: 'Could not start the payment', message: e instanceof Error ? e.message : String(e) }), e instanceof InputError ? 400 : 502)
    }
  })

  // The open-spec documents for a product.
  app.get('/p/:slug/opensite.json', (c) => {
    const p = live(c.req.param('slug'))
    return p?.record ? c.json(p.record, 200, { 'access-control-allow-origin': '*' }) : c.json({ error: 'not found' }, 404)
  })
  app.get('/p/:slug/openprofile.md', (c) => {
    const p = live(c.req.param('slug'))
    return p ? c.body(service.openProfile(p), 200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }) : c.text('not found', 404)
  })

  // Pictures we saved. SVG is served sandboxed: it is a picture, never a document.
  app.get('/m/:id/:file', async (c) => {
    const { id, file } = c.req.param()
    const body = await service.media.read(id, file)
    if (!body) return c.notFound()
    const type = IMAGE_TYPES[file.split('.').pop()!]!
    return c.body(body as Uint8Array<ArrayBuffer>, 200, { 'content-type': type, 'cache-control': 'public, max-age=604800', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox", 'x-content-type-options': 'nosniff' })
  })

  // The badge: the viral part. Cached briefly so the count stays live.
  const badgeImage = (c: Context<Env>, p: Product | null) => {
    if (!p) return c.body('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 404, { 'content-type': 'image/svg+xml' })
    return c.body(badgeSvg(p, store.awards(p.id), c.req.query('theme') === 'light' ? 'light' : 'dark'), 200, {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'access-control-allow-origin': '*',
      'cross-origin-resource-policy': 'cross-origin',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
    })
  }
  app.get('/badge/:file{[a-z0-9-]+\\.svg}', (c) => badgeImage(c, live(c.req.param('file').replace(/\.svg$/, ''))))
  // The same badge by badge id: the one the claim page hands out. On a homepage it claims the listing for that account.
  // By site, for snippets shared across many sites (the Profullstack footer): ?site=<homepage>.
  app.get('/for.svg', (c) => badgeImage(c, store.bySite(c.req.query('site') ?? '')))
  app.get('/for', (c) => {
    const p = store.bySite(c.req.query('site') ?? '')
    return c.redirect(p ? `/p/${p.slug}?ref=badge` : '/')
  })
  app.get('/images.svg', (c) => {
    const b = store.badge(c.req.query('id') ?? '')
    const p = b ? store.product(b.productId) : null
    return badgeImage(c, p?.status === 'live' ? p : null)
  })

  app.get('/makers/:id', (c) => {
    const m = store.maker(c.req.param('id'))
    return m ? page(c, makerPage(ctxOf(c), { maker: m, products: store.byMaker(m.id) })) : page(c, messagePage(ctxOf(c), { title: 'Not here', message: 'No such maker.' }), 404)
  })
  app.get('/makers/:id/openprofile.md', (c) => {
    const md = service.makerProfile(c.req.param('id'))
    return md ? c.body(md, 200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }) : c.text('not found', 404)
  })

  // Feeds and files for machines.
  app.get('/feed.xml', (c) => {
    const items = store
      .list('new', 50)
      .map((p) => `<item><title>${esc(`${p.name}: ${p.tagline}`)}</title><link>${origin}/p/${p.slug}</link><guid isPermaLink="true">${origin}/p/${p.slug}</guid><pubDate>${new Date(p.launchedAt ?? p.createdAt).toUTCString()}</pubDate><description>${esc(p.description)}</description>${cardImage(origin, p) ? `<enclosure url="${esc(cardImage(origin, p))}" type="image/png" length="0"/>` : ''}</item>`)
      .join('')
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>built.indie launches</title><link>${origin}/</link><description>Indie products launched on built.indie</description>${items}</channel></rss>`, 200, { 'content-type': 'application/rss+xml; charset=utf-8' })
  })
  app.get('/sitemap.xml', (c) => {
    const urls = ['/', '/top/today', '/top/week', '/top/month', '/top/all', '/new', '/submit', '/help', '/invite', '/leaderboard', ...store.list('all', 5000).map((p) => `/p/${p.slug}`)]
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml' })
  })
  app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /p/*/edit\nSitemap: ${origin}/sitemap.xml\n`))
  app.get('/llms.txt', (c) =>
    c.text(`# built.indie\n\n> Launch your indie product with one URL. built.indie reads your homepage (meta tags, Open Graph, JSON-LD, llms.txt, OpenSite, OpenProfile), saves the logo and screenshots, and puts it on a daily upvote board. Free, open source, no account.\n\n## API\n\n- [Help](${origin}/help): JSON API, CLI, TUI and MCP\n- [Today](${origin}/api/v1/products?window=today): today's launches as JSON\n- [Launch](${origin}/help#api): POST /api/v1/products {"url": "..."}\n- [MCP](${origin}/help#mcp): claude mcp add builtindie -- bunx @profullstack/builtindie mcp\n- [Install](${origin}/install.sh): curl -fsSL ${origin}/install.sh | sh\n- [Feed](${origin}/feed.xml): RSS of every launch\n`),
  )
  app.get('/.well-known/openprofile.md', (c) =>
    c.body(`# built.indie\n\n- **Kind**: organization\n- **Web**: ${origin}\n- **Avatar**: ${origin}/icon-512.png\n\nLaunch your indie product with one URL.\n\n## Accounts\n\n- ${'https://github.com/moshcoder/built.indie'}\n- https://pit.world/ring\n\n## Topics\n\n- indie\n- launches\n- startups\n\n## Operator\n\n- **Name**: Profullstack, Inc.\n- **Profile**: https://profullstack.com/.well-known/openprofile.md\n`, 200, { 'content-type': 'text/markdown; charset=utf-8', 'access-control-allow-origin': '*' }),
  )
  app.get('/.well-known/opensite.json', (c) =>
    c.json(
      {
        opensite: '0.1',
        site: { name: 'built.indie', web: origin, description: 'Launch your indie product with one URL.', icon: `${origin}/icon-512.png`, language: 'en', operator: `${origin}/.well-known/openprofile.md`, kinds: ['product', 'page'], feeds: [`${origin}/feed.xml`], sitemaps: [`${origin}/sitemap.xml`] },
        index: { allow: true, refresh: 3600 },
      },
      200,
      { 'access-control-allow-origin': '*' },
    ),
  )

  // The JSON API.
  const apiProduct = (p: Product) => ({
    slug: p.slug,
    name: p.name,
    tagline: p.tagline,
    description: p.description,
    url: p.url,
    domain: p.domain,
    status: p.status,
    votes: p.votes,
    tags: p.tags,
    logo: p.logo ? `${origin}/m/${p.id}/${p.logo}` : null,
    card_image: p.ogImage ? `${origin}/m/${p.id}/${p.ogImage}` : null,
    screenshot: p.screenshot ? `${origin}/m/${p.id}/${p.screenshot}` : null,
    images: p.images.map((f) => `${origin}/m/${p.id}/${f}`),
    videos: p.videos,
    socials: p.socials,
    llms: p.llms,
    profile: p.profile,
    maker: p.makerName || p.makerProfile ? { name: p.makerName, profile: p.makerProfile, verified: p.makerVerified, page: p.makerId ? `${origin}/makers/${p.makerId}` : null } : null,
    verified: Boolean(p.verifiedAt),
    featured_until: p.featuredUntil ? new Date(p.featuredUntil).toISOString() : null,
    launched_at: p.launchedAt ? new Date(p.launchedAt).toISOString() : null,
    page: `${origin}/p/${p.slug}`,
    badge: `${origin}/badge/${p.slug}.svg`,
    stack: p.extras.stack,
    pricing: p.extras.pricing,
    openicon: p.extras.openicon,
    opensite: `${origin}/p/${p.slug}/opensite.json`,
    openprofile: `${origin}/p/${p.slug}/openprofile.md`,
  })
  const apiError = (c: Context, e: unknown) => {
    if (!(e instanceof InputError) && !(e instanceof FetchError)) console.error('api', e)
    return c.json({ error: e instanceof Error ? e.message : String(e), ...(e instanceof InputError && e.field ? { field: e.field } : {}) }, e instanceof InputError || e instanceof FetchError ? 400 : 502)
  }
  const body = async (c: Context) => ((await c.req.json().catch(() => ({}))) ?? {}) as Record<string, any>
  const apiUser = (c: Context) => store.byApiKey(bearer(c))
  const owned = (c: Context) => {
    const p = store.bySlug(c.req.param('slug') ?? '')
    return p && store.canEdit(p, apiUser(c)) ? p : null
  }
  const NEEDS_KEY = { error: 'send your API key (from /me): authorization: Bearer bi_…, for a product you submitted or claimed (/p/<slug>/claim)' }

  app.post('/api/v1/preview', async (c) => {
    if (!readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many reads from you; wait a few minutes' }, 429)
    try {
      return c.json(await autofetch(String((await body(c)).url ?? ''), config.fetch))
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.post('/api/v1/products', async (c) => {
    const admin = isAdmin(c)
    if (!admin && !readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many launches from you; wait a few minutes' }, 429)
    const b = await body(c)
    try {
      const user = apiUser(c)
      const r = await service.submit({ url: String(b.url ?? ''), makerName: b.maker_name, makerProfile: b.maker_profile }, store.voterFor(ip(c)), user, admin)
      if (r.existing) return c.json({ existing: true, product: apiProduct(r.product) }, 200)
      let p = r.product
      if (user && (b.name || b.tagline || b.description || b.tags || b.videos)) p = await service.edit(p, { name: b.name, tagline: b.tagline, description: b.description, tags: b.tags, videos: b.videos })
      if (user && b.publish !== false && p.status === 'draft') p = service.publish(p)
      return c.json({ product: apiProduct(p), claim_url: `${origin}/p/${p.slug}/claim` }, 201)
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.get('/api/v1/products', (c) => {
    const w = (c.req.query('window') ?? 'today') as Window
    const q = c.req.query('q')
    if (!q && !WINDOWS.includes(w)) return c.json({ error: `window is one of ${WINDOWS.join(', ')}` }, 400)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    return c.json({ window: q ? 'search' : w, products: (q ? store.search(q.slice(0, 60), limit) : store.list(w, limit, offset)).map(apiProduct) }, 200, { 'access-control-allow-origin': '*' })
  })

  app.get('/api/v1/products/:slug', (c) => {
    const p = store.bySlug(c.req.param('slug'))
    const mine = owned(c)
    if (!p || (p.status !== 'live' && !mine)) return c.json({ error: 'no such product' }, 404)
    return c.json({ ...apiProduct(p), award: store.awards(p.id) }, 200, { 'access-control-allow-origin': '*' })
  })

  app.patch('/api/v1/products/:slug', async (c) => {
    const p = owned(c)
    if (!p) return c.json(NEEDS_KEY, 401)
    const b = await body(c)
    try {
      return c.json(apiProduct(await service.edit(p, { name: b.name, tagline: b.tagline, description: b.description, tags: b.tags, videos: b.videos, makerName: b.maker_name, makerProfile: b.maker_profile, socials: b.socials, remove: b.remove })))
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.post('/api/v1/products/:slug/:action{(publish|refetch|verify|feature)}', async (c) => {
    const action = c.req.param('action')
    const p = action === 'verify' ? live(c.req.param('slug')) : owned(c)
    if (!p) return c.json(action === 'verify' ? { error: 'no such product' } : NEEDS_KEY, action === 'verify' ? 404 : 401)
    try {
      if (action === 'publish') return c.json(apiProduct(service.publish(p)))
      if (!readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many reads from you; wait a few minutes' }, 429)
      if (action === 'refetch') return c.json(apiProduct(await service.refetch(p)))
      if (action === 'verify') return c.json({ verified: await service.verify(p) })
      const r = await service.feature(p, String((await body(c)).chain ?? ''))
      return c.json({ checkout_url: r.checkoutUrl, payment: r.ref, usd: config.featureUsd, days: config.featureDays })
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.post('/api/v1/products/:slug/vote', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    if (crossSite(c)) return c.json({ error: 'vote from built.indie itself' }, 403)
    const counted = voteLimit.allow(`vote:${ip(c)}`) && store.vote(p.id, voter(c))
    return c.json({ slug: p.slug, votes: store.product(p.id)!.votes, counted })
  })

  app.delete('/api/v1/products/:slug', async (c) => {
    // The maker deletes; an admin takes down (hidden, kept for the record).
    if (isAdmin(c)) {
      const p = store.bySlug(c.req.param('slug'))
      if (!p) return c.json({ error: 'no such product' }, 404)
      store.update(p.id, { status: 'hidden' })
      store.revokeInvite(p.id)
      board.invalidate()
      return c.json({ hidden: true })
    }
    const p = owned(c)
    if (!p) return c.json(NEEDS_KEY, 401)
    store.delete(p.id)
    await service.media.remove(p.id)
    return c.json({ deleted: true })
  })

  const NEEDS_ACCOUNT = { error: 'send your API key (from /me): authorization: Bearer bi_…' }
  app.get('/api/v1/products/:slug/claim', (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.json({ error: 'no such product' }, 404)
    return c.json({ owner: p.ownerId === user.id, record: claimRecord(p, user), badge: claimBadge(p, user), markdown: claimMd(p, user) })
  })
  app.post('/api/v1/products/:slug/claim', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.json({ error: 'no such product' }, 404)
    if (!readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many checks; wait a few minutes' }, 429)
    const r = await service.claim(p, user)
    return c.json({ claimed: r.ok, ...(r.method ? { method: r.method } : {}), looked: r.looked, record: claimRecord(p, user), badge: claimBadge(p, user), ...(r.ok ? {} : { markdown: claimMd(p, user) }) })
  })
  app.get('/api/v1/me', (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    return c.json({ email: user.email, products: store.mine(user.id).map((p) => ({ ...apiProduct(p), owner: p.ownerId === user.id })), invite: apiInvite(user) })
  })
  const apiInvite = (user: User) => {
    const s = store.inviteStats(user.id)
    return { link: inviteLink(user), code: s.code, invited: s.invited, launched: s.launched, credits: s.credits, used: s.used, feature_days: config.featureDays }
  }
  app.get('/api/v1/invites', (c) => {
    const user = apiUser(c)
    return user ? c.json(apiInvite(user)) : c.json(NEEDS_ACCOUNT, 401)
  })
  app.post('/api/v1/products/:slug/credit', (c) => {
    const user = apiUser(c)
    const p = owned(c)
    if (!user || !p) return c.json(NEEDS_KEY, 401)
    try {
      const after = service.redeemCredit(p, user)
      return c.json({ featured_until: new Date(after.featuredUntil!).toISOString(), credits: store.inviteStats(user.id).credits })
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.get('/api/v1/makers/:id', (c) => {
    const m = store.maker(c.req.param('id'))
    return m ? c.json({ ...m, page: `${origin}/makers/${m.id}`, products: store.byMaker(m.id).map(apiProduct) }) : c.json({ error: 'no such maker' }, 404)
  })

  // OpenSite index calls (logicsrc.com/docs/opensite, "Publishing a record").
  app.get('/api/v1/sites', (c) => {
    const url = c.req.query('url') ?? ''
    let p: Product | null = null
    try {
      p = url ? store.byUrl(url.startsWith('http') ? url : `https://${url}`) : null
    } catch {}
    return p?.record && p.status === 'live' ? c.json(p.record, 200, { 'access-control-allow-origin': '*' }) : c.json({ error: 'no record for that URL; POST /api/v1/sites to read it' }, 404)
  })
  app.post('/api/v1/sites', async (c) => {
    if (!readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many reads from you; wait a few minutes' }, 429)
    try {
      return c.json(service.recordFrom(await autofetch(String((await body(c)).url ?? ''), config.fetch)))
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.get('/api/v1/stats', (c) => c.json({ ...store.count(), version: VERSION }))

  // CoinPay's events for the Featured slot.
  app.post('/hooks/coinpay', async (c) => {
    const raw = await c.req.text()
    const r = service.webhook(raw, c.req.header('x-coinpay-signature'))
    return r.ok ? c.json({ ok: true }) : c.json({ error: 'bad signature' }, (r.status ?? 401) as 401)
  })

  app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: 'not found' }, 404) : page(c, messagePage(ctxOf(c as Context<Env>), { title: 'Not found', message: 'That page does not exist.' }), 404)))
  app.onError((error, c) => {
    console.error(error instanceof Error ? error.stack : error)
    return c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong.' }, 500) : page(c, messagePage(ctxOf(c as Context<Env>), { title: 'Something went wrong', message: 'Try again in a moment.' }), 500)
  })
  return app
}

/** The client's address: nginx's X-Real-IP, or, when the request came through the pit.world relay on this box, the relay's X-Forwarded-For. */
export function clientIp(peer: string, headers: Headers, relays: string[]): string {
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (!loopback) return peer
  const real = headers.get('x-real-ip') ?? ''
  if (real && relays.includes(real) && headers.get('x-moshpit-name')) {
    const first = (headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim() ?? ''
    if (first && !privateAddress(first)) return first
  }
  return real || peer
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): Config {
  const coinpay =
    env.COINPAY_API_KEY && env.COINPAY_BUSINESS_ID
      ? { baseUrl: (env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''), apiKey: env.COINPAY_API_KEY, businessId: env.COINPAY_BUSINESS_ID, webhookSecret: env.COINPAY_WEBHOOK_SECRET ?? '' }
      : null
  const chains = (env.COINPAY_CHAINS ?? '').split(/[\s,]+/).filter(Boolean)
  return {
    origin: (env.BUILTINDIE_ORIGIN ?? PUBLIC_ORIGIN).replace(/\/+$/, ''),
    coinpay,
    featureUsd: Number(env.FEATURE_USD ?? 19),
    featureDays: Number(env.FEATURE_DAYS ?? 7),
    chains: chains.length ? chains : DEFAULT_CHAINS,
    screenshots: env.BUILTINDIE_SCREENSHOTS !== 'off',
  }
}

export function serve(options: { port?: number; hostname?: string } = {}) {
  const env = process.env
  const dataDir = env.BUILTINDIE_DATA ?? `${env.HOME}/.local/share/built-indie`
  const store = new Store(env.BUILTINDIE_DB ?? `${dataDir}/built-indie.db`, env.BUILTINDIE_KEY ?? '')
  const media = new Media(env.BUILTINDIE_MEDIA ?? `${dataDir}/media`)
  const service = new BuiltIndie(store, media, { ...configFromEnv(env), claimSecret: env.BUILTINDIE_KEY })
  const mailer = env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.MAIL_FROM ?? 'built.indie <built@pit.world>') : consoleMailer
  const app = createApp({ service, auth: new Auth(store, mailer), adminKey: env.BUILTINDIE_ADMIN_KEY, mailer })
  const relays = (env.BUILTINDIE_RELAY_IPS ?? '23.95.228.174,127.0.0.1,::1').split(/[\s,]+/).filter(Boolean)
  startRingRefresh()
  startPitFooterRefresh('built.indie')
  // Drafts nobody launched within a day go, pictures too.
  const sweep = () => void Promise.all(store.sweepDrafts().map((id) => media.remove(id))).catch(() => {})
  sweep()
  setInterval(sweep, 3600_000).unref?.()
  // Badges placed since launch only count once someone presses Verify; look again every 6 hours, a few at a time.
  const reverify = async () => {
    for (const p of store.unverified()) await service.verify(p).catch(() => false)
  }
  setTimeout(() => void reverify(), 60_000).unref?.()
  setInterval(() => void reverify(), 6 * 3600_000).unref?.()
  return Bun.serve({
    port: options.port ?? Number(env.PORT ?? 8798),
    hostname: options.hostname ?? env.HOST ?? '127.0.0.1',
    idleTimeout: 120,
    maxRequestBodySize: 1024 * 1024,
    fetch(request, srv) {
      return app.fetch(request, { ip: clientIp(srv.requestIP(request)?.address ?? '', request.headers, relays) })
    },
  })
}

if (import.meta.main) {
  const server = serve()
  startRingFooterRefresh()
  console.log(`built.indie listening on http://${server.hostname}:${server.port}`)
}
