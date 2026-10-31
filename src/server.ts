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
import { Store, type Comment, type Product, type Review, type User, type Window } from './db.js'
import { privateAddress } from './fetch.js'
import { CATEGORY_LABELS, parseQuery, queryString, search } from './browse.js'
import { badgeSvg, launchBadgeSvg, boardPage, browsePage, cardImage, claimBadgeSnippet, claimMarkdown, claimPage, editPage, esc, helpPage, homePage, inviteLanding, invitePage, leaderboardPage, loginPage, makerPage, mePage, messagePage, productPage, submitPage, tagsPage, type CommentView, type Ctx, type InviterRow, type ReviewView } from './html.js'
import { normalizeTag } from './tags.js'
import { siteLeaderboard } from './leaderboard.js'
import { HOW_TO_EARN, SHARE_NETWORKS } from './karma.js'
import { IMAGE_TYPES, Media } from './media.js'
import { startPitFooterRefresh } from './pit-footer.js'
import { RING_PLACEHOLDER, ringBar, startRingRefresh, visitorOnMoshpit } from './ring.js'
import { BuiltIndie, CLAIM_LABEL, CLAIM_PREFIX, INVITE_BONUS_DAYS, INVITES_PER_PERSON, InputError, type Config, type Edit } from './service.js'
import { autofetch, FetchError } from './fetch.js'
import { COINPAY_ERRORS, coinpayOAuthFromEnv, isPlaceholder, mountCoinPaySignin, PROVIDER as COINPAY, type CoinPayOAuth } from './coinpay-signin.js'
import { VERSION } from './version.js'
import { webhooksApi } from '@profullstack/webhooks'
import { mountProfileRoutes, PROFILE_ENHANCE_SCRIPT, saveSignupProfile, validateProfile } from '@profullstack/profile'
import { openProfiles } from './profile.js'

export { VERSION }

const SELF = 'built.indie'
export const PUBLIC_ORIGIN = 'https://built.indie.pit.world'

const CSP = [
  "default-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self' https://crawlproof.com",
  // The shared footer's badges: ours is same-origin, pwamart's is not.
  "img-src 'self' data: https://pwamart.com",
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

export type Deps = { service: BuiltIndie; auth: Auth; adminKey?: string; secureCookies?: boolean; mailer?: Mailer; /** Sign in with CoinPay; off when null. */ coinpayOAuth?: CoinPayOAuth | null }

/** The invite code from /i/<code>, kept until the visitor signs up (it also rides in the magic link). */
const REF_COOKIE = 'bi_ref'
/** A scarce single-use invite code (INV-XXXX-XXXX-XXXX) from /i/<code>, kept until the visitor signs up. */
const INVITE_COOKIE = 'bi_invite'
/** An @profullstack/affiliates invite code, as opposed to a member's open invite-link code. */
const isInviteCode = (code: string | null | undefined): code is string => Boolean(code && /^INV-?[0-9A-Z]{4}-?[0-9A-Z]{4}-?[0-9A-Z]{4}$/i.test(code.trim()))
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
  const commentLimit = new Limiter(10, 10 * 60_000)
  const shareLimit = new Limiter(60, 10 * 60_000)
  const redeemLimit = new Limiter(10, 10 * 60_000)
  const hookLimit = new Limiter(30, 10 * 60_000)
  const origin = config.origin
  // The shared profile fields (profile.ts); user_profiles is created as the app starts.
  const profiles = openProfiles(store.db)

  const direct = (c: Context) => visitorOnMoshpit(SELF, c.req.header('host'), c.req.header('x-moshpit-name'))
  const ip = (c: Context<Env>) => c.env?.ip ?? 'local'
  const voter = (c: Context<Env>) => store.voterFor(ip(c))
  const sessionUser = (c: Context) => deps.auth.sessionUser(getCookie(c, SESSION_COOKIE))
  const ctxOf = (c: Context<Env>): Ctx => {
    const v = voter(c)
    return { origin, user: sessionUser(c), voted: (id) => store.voted(id, v), coinpay: Boolean(deps.coinpayOAuth) }
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

  // The leaderboards (@profullstack/leaderboard over the karma ledger and the invites table).
  const board = siteLeaderboard(store, origin)
  const rowsOf = async (id: 'karma' | 'invites', period: 'week' | 'month' | 'all', limit: number): Promise<InviterRow[]> => (await board.top({ board: id, period, limit })).rows.map((r) => ({ ...r, url: `/leaderboard/u/${encodeURIComponent(r.id)}` }))
  const inviters = (limit: number) => rowsOf('invites', 'week', limit)
  /** Top karma this week; an empty week falls back to all time so the widget never looks dead. */
  const topKarma = async (limit: number): Promise<{ period: 'week' | 'all'; rows: InviterRow[] }> => {
    const week = await rowsOf('karma', 'week', limit)
    return week.length ? { period: 'week', rows: week } : { period: 'all', rows: await rowsOf('karma', 'all', limit) }
  }
  // Every karma write: the board re-reads the ledger and checks badges (a projection is never record()ed).
  service.karma.onChange = (userId) => {
    board.invalidate()
    board.award(userId).catch((e) => console.error(`[karma] badges: ${(e as Error).message}`))
  }
  service.karma.onCredit = (userId, granted) => {
    const u = store.user(userId)
    if (!u || !deps.mailer) return
    const text = `Your karma on built.indie crossed another ${service.karma.perCredit}: that is ${granted === 1 ? 'a free Featured week' : `${granted} free Featured weeks`} (${config.featureDays} days pinned on the homepage).\n\nUse it: ${origin}/invite\nYour karma: ${origin}/me#karma`
    deps.mailer({ to: u.email, subject: 'Your karma earned a free Featured week on built.indie', text, html: `<p>${esc(text).replace(/\n/g, '<br>')}</p>` }).catch((e) => console.error(`[karma] mail failed: ${(e as Error).message}`))
  }
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

  // ?ref=<a member's invite code> on any page is their invite link too: the same bi_ref cookie
  // /i/<code> sets, first touch wins, so one sign-up is counted once, in one place (the invites table).
  app.use('*', async (c, next) => {
    const ref = c.req.query('ref')
    if (ref && ref.length <= 40 && !getCookie(c, REF_COOKIE) && store.inviterOf(ref) && !sessionUser(c)) setCookie(c, REF_COOKIE, ref, { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
    await next()
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
    page(c, homePage(ctxOf(c), { today: store.list('today'), featured: store.list('featured', 3), yesterday: store.onDay(new Date(Date.now() - 86400_000).toISOString().slice(0, 10), 3), stats: store.count(), inviters: await inviters(5), karma: await topKarma(5), featureDays: config.featureDays, featureUsd: config.featureUsd })),
  )
  app.get('/top/:window', (c) => {
    const w = c.req.param('window') as Window
    if (!WINDOWS.includes(w)) return c.notFound()
    return page(c, boardPage(ctxOf(c), w, store.list(w, 50)))
  })
  app.get('/new', (c) => page(c, boardPage(ctxOf(c), 'new', store.list('new', 50))))
  // Browse and search, with facets (browse.ts). /c/ and /t/ are one filter each, at an indexable address.
  const browse = (c: Context, extra: Record<string, string> = {}) => {
    const params = new URL(c.req.url).searchParams
    for (const [k, v] of Object.entries(extra)) if (!params.getAll(k).includes(v)) params.append(k, v)
    return search(store.allLive(), parseQuery(params))
  }
  app.get('/search', (c) => page(c, browsePage(ctxOf(c), browse(c))))
  app.get('/c/:category', (c) => {
    const key = c.req.param('category')
    if (!(key in CATEGORY_LABELS)) return c.notFound()
    const label = CATEGORY_LABELS[key]!
    // Further filters go to /search, so /c/<category> stays one page.
    if (new URL(c.req.url).search) return c.redirect(`/search?category=${encodeURIComponent(key)}&${new URL(c.req.url).searchParams}`)
    return page(c, browsePage(ctxOf(c), browse(c, { category: key }), { path: `/c/${key}`, heading: label, intro: `${label}: indie products launched on built.indie` }))
  })
  app.get('/t/:tag', (c) => {
    const tag = normalizeTag(c.req.param('tag'))
    if (!tag) return c.notFound()
    if (tag !== c.req.param('tag')) return c.redirect(`/t/${encodeURIComponent(tag)}`, 301)
    if (new URL(c.req.url).search) return c.redirect(`/search?tag=${encodeURIComponent(tag)}&${new URL(c.req.url).searchParams}`)
    const r = browse(c, { tag })
    return page(c, browsePage(ctxOf(c), r, { path: `/t/${encodeURIComponent(tag)}`, heading: `#${tag}`, intro: `Indie products tagged ${tag}` }), r.total ? 200 : 404)
  })
  app.get('/tags', (c) => page(c, tagsPage(ctxOf(c), store.tagCounts())))
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
  /** Comments and reviews as the page shows them: public names and karma, never emails. */
  const discussion = (p: Product, me: User | null) => {
    const comments = store.comments(p.id)
    const reviews = store.reviews(p.id)
    const karmaOf = store.karmaOf([...comments.map((x) => x.userId), ...reviews.map((x) => x.userId)])
    const names = new Map<string, string>()
    const who = (id: string) => names.get(id) ?? (names.set(id, store.publicName(id)), names.get(id)!)
    const owner = p.ownerId ?? p.submitterUser
    const cv = (x: Comment): CommentView => ({ id: x.id, parentId: x.parentId, body: x.body, deleted: Boolean(x.deletedAt), at: x.createdAt, author: x.deletedAt ? '' : who(x.userId), karma: karmaOf.get(x.userId) ?? 0, maker: x.userId === owner, mine: Boolean(me && x.userId === me.id) })
    const rv = (x: Review): ReviewView => ({ rating: x.rating, body: x.body, at: x.updatedAt, author: who(x.userId), karma: karmaOf.get(x.userId) ?? 0, mine: Boolean(me && x.userId === me.id) })
    return { comments: comments.map(cv), reviews: reviews.map(rv), myReview: me ? store.review(p.id, me.id) : null }
  }
  const productView = async (c: Context<Env>, p: Product, extra: { error?: string } = {}, status = 200) =>
    page(
      c,
      productPage(ctxOf(c), {
        ...discussion(p, sessionUser(c)),
        error: extra.error,
        selfListing: (() => {
          const u = sessionUser(c)
          return Boolean(u && (p.ownerId === u.id || p.submitterUser === u.id))
        })(),
        product: p,
        award: store.awards(p.id),
        maker: p.makerId ? store.maker(p.makerId) : null,
        featuredOk: c.req.query('featured') === '1',
        featuredCredit: c.req.query('featured') === 'credit',
        featuredDaysUsed: c.req.query('featured') === 'days',
        daysBalance: await (async () => {
          const u = sessionUser(c)
          return u && store.canEdit(p, u) ? service.featuredDays(u) : 0
        })(),
        launched: c.req.query('launched') === '1',
        canEdit: store.canEdit(p, sessionUser(c)),
        credits: (() => {
          const u = sessionUser(c)
          return u && store.canEdit(p, u) ? store.inviteStats(u.id).credits : 0
        })(),
        buyerEmail: sessionUser(c)?.email ?? '',
        featureUsd: config.featureUsd,
        featureDays: config.featureDays,
        payments: Boolean(config.coinpay),
      }),
      status,
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
  const claimSquareBadge = (p: Product, user: User) => claimBadgeSnippet(origin, p, store.badgeId(p.id, user.id), 'square')
  const claimMd = (p: Product, user: User) => claimMarkdown(origin, p, claimRecord(p, user), claimBadge(p, user), claimSquareBadge(p, user))
  const claimView = (c: Context<Env>, p: Product, user: User, extra: { result?: { ok: boolean; looked: string[]; method?: string } } = {}, status = 200) =>
    page(c, claimPage(ctxOf(c), { product: p, record: claimRecord(p, user), badge: claimBadge(p, user), squareBadge: claimSquareBadge(p, user), owner: p.ownerId === user.id, ...extra }), status)
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

  /**
   * A new member: a scarce invite code (bi_invite) gives both people Featured days, and an
   * invite link (bi_ref, /i/<code> or ?ref=) makes their first live listing earn the inviter a credit.
   * Both write the same invites row, first one wins, so a sign-up is counted once.
   */
  const joined = async (c: Context, user: User, carried: string | null) => {
    const parts = (carried ?? '').split(' ').filter(Boolean)
    const invite = parts.find(isInviteCode) ?? getCookie(c, INVITE_COOKIE)
    const ref = parts.find((x) => !isInviteCode(x)) ?? getCookie(c, REF_COOKIE)
    if (invite) await service.acceptInvite(invite, user).catch((e) => console.error(`[invite] accept failed: ${(e as Error).message}`))
    if (ref) store.recordInvite(user.id, ref)
    for (const name of [REF_COOKIE, INVITE_COOKIE]) deleteCookie(c, name, { path: '/' })
  }

  // Signing in: an emailed link, which is also sign-up.
  const invitedBy = (c: Context) => {
    const inviter = store.inviterOf(getCookie(c, REF_COOKIE) ?? '')
    return inviter && !sessionUser(c) ? store.publicName(inviter) : null
  }
  app.get('/login', (c) => page(c, loginPage(ctxOf(c), { next: safeNext(c.req.query('next')), invitedBy: invitedBy(c), error: COINPAY_ERRORS[c.req.query('error') ?? ''] })))
  // Creating an account asks for the shared profile fields; plain sign-in never does.
  app.get('/signup', (c) => page(c, loginPage(ctxOf(c), { next: safeNext(c.req.query('next')), invitedBy: invitedBy(c), signup: true })))
  app.get('/vendor-profile.js', (c) => c.body(PROFILE_ENHANCE_SCRIPT, 200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }))
  // Sign in with CoinPay (coinpay-signin.ts): /api/v1/coinpay/login and /callback.
  mountCoinPaySignin(app, {
    store,
    auth: deps.auth,
    origin,
    oauth: deps.coinpayOAuth ?? null,
    secure,
    sessionUser,
    // A new member who came through an invite link counts, as with a magic link.
    onNewMember: (c, user) => void joined(c, user, null),
  })
  app.post('/login', async (c) => {
    const form = (await c.req.parseBody()) as Record<string, string>
    const next = safeNext(form.next)
    const signup = form.mode === 'signup'
    if (!validEmail(form.email)) return page(c, loginPage(ctxOf(c), { next, error: 'That does not look like an email address.', email: form.email, signup, values: form }), 400)
    // The signup fields are checked before any link exists; they ride on the link and are saved on verify.
    let profile: object | null = null
    if (signup) {
      const check = validateProfile(form)
      if (!check.ok) return page(c, loginPage(ctxOf(c), { next, error: 'Some fields need fixing.', email: form.email, signup, values: form, errors: check.errors }), 400)
      profile = check.profile
    }
    // The invites ride in the link (space-separated), so opening it in another browser still counts.
    if (!crossSite(c) && readLimit.allow(`mail:${ip(c)}`)) await deps.auth.sendLink(form.email ?? '', next, here(c), [getCookie(c, INVITE_COOKIE), getCookie(c, REF_COOKIE)].filter(Boolean).join(' ') || null, profile)
    return page(c, loginPage(ctxOf(c), { next, sent: true }))
  })
  app.get('/auth/verify', async (c) => {
    const r = deps.auth.consumeLink(c.req.query('token') ?? '')
    if (!r) return page(c, messagePage(ctxOf(c), { title: 'That link is used up', message: 'Sign-in links work once, for 20 minutes. Ask for a new one.' }), 400)
    setCookie(c, SESSION_COOKIE, deps.auth.createSession(r.user.id), { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 90 * 86400 })
    if (r.created) await joined(c, r.user, r.ref ?? null)
    else for (const name of [REF_COOKIE, INVITE_COOKIE]) deleteCookie(c, name, { path: '/' })
    // The signup form's fields, now that the account exists. A failure never costs the sign-in: /me asks again.
    if (r.profile) await saveSignupProfile(await profiles.ready, r.user.id, r.profile, { email: r.user.email }).catch((error) => console.error(`[auth] signup profile save failed: ${(error as Error).message}`))
    return c.redirect(r.next ?? '/me')
  })
  app.post('/logout', (c) => {
    if (!crossSite(c)) deps.auth.endSession(getCookie(c, SESSION_COOKIE))
    deleteCookie(c, SESSION_COOKIE, { path: '/' })
    return c.redirect('/')
  })
  const signinInfo = (c: Context, user: User) => ({
    coinpay: store.identities(user.id).find((i) => i.provider === COINPAY) ?? null,
    emailless: isPlaceholder(user.email),
    coinpayNote: ({ connected: 'CoinPay is connected: sign in with it next time.', taken: 'That CoinPay account is already linked to another built.indie member.', welcome: 'Welcome! You signed in with CoinPay.' } as Record<string, string>)[c.req.query('coinpay') ?? ''] ?? null,
  })
  app.get('/me', async (c) => {
    const user = sessionUser(c)
    return user ? page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), invite: store.inviteStats(user.id), karma: service.karma.summary(user.id), howToEarn: HOW_TO_EARN, featureDays: config.featureDays, daysBalance: await service.featuredDays(user), ...signinInfo(c, user), webhooks: await service.hooks.listEndpoints(user.id), profile: await (await profiles.ready).get(user.id), detailsNote: c.req.query('details') === 'saved' ? 'Your details are saved.' : null })) : toLogin(c)
  })
  // "Have a code?": a credit code (@profullstack/redeem-credits) adds Featured days to the balance.
  app.post('/me/redeem', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/me')
    const code = String(((await c.req.parseBody()) as Record<string, string>).code ?? '')
    let note: string
    let status = 200
    if (!redeemLimit.allow(`redeem:${user.id}`) || !redeemLimit.allow(`redeem-ip:${ip(c)}`)) (note = 'Too many tries. Wait a few minutes.'), (status = 429)
    else
      try {
        note = (await service.redeem(user, code)).message
      } catch (e) {
        note = e instanceof Error ? e.message : String(e)
        status = 400
      }
    return page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), invite: store.inviteStats(user.id), karma: service.karma.summary(user.id), howToEarn: HOW_TO_EARN, featureDays: config.featureDays, daysBalance: await service.featuredDays(user), redeemNote: note, redeemError: status !== 200, ...signinInfo(c, user), webhooks: await service.hooks.listEndpoints(user.id), profile: await (await profiles.ready).get(user.id) }), status)
  })
  // Spend Featured days from the balance on a listing you own.
  app.post('/p/:slug/feature-days', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.notFound()
    if (crossSite(c) || !store.canEdit(p, user)) return c.redirect(`/p/${p.slug}`)
    const days = Number(((await c.req.parseBody()) as Record<string, string>).days ?? 0)
    try {
      await service.spendFeaturedDays(p, user, days)
      return c.redirect(`/p/${p.slug}?featured=days`)
    } catch (e) {
      return productView(c, p, { error: e instanceof Error ? e.message : String(e) }, 400)
    }
  })
  // The shared profile (@profullstack/profile): the /me form, and GET/PUT/PATCH /api/v1/me/profile for a session or an API key.
  app.post('/me/profile', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/me')
    const form = (await c.req.parseBody()) as Record<string, string>
    const email = isPlaceholder(user.email) ? null : user.email
    const check = validateProfile({ ...form, email }, { required: ['first_name', 'last_name'] })
    if (!check.ok) return page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), invite: store.inviteStats(user.id), karma: service.karma.summary(user.id), howToEarn: HOW_TO_EARN, featureDays: config.featureDays, daysBalance: await service.featuredDays(user), ...signinInfo(c, user), webhooks: await service.hooks.listEndpoints(user.id), profile: form, detailsNote: 'Some fields need fixing.', detailsError: true, detailsErrors: check.errors }), 400)
    await (await profiles.ready).save(user.id, check.profile)
    return c.redirect('/me?details=saved#details')
  })
  app.post('/me/key', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/me')
    return page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), apiKey: store.newApiKey(user.id), invite: store.inviteStats(user.id), karma: service.karma.summary(user.id), howToEarn: HOW_TO_EARN, featureDays: config.featureDays, daysBalance: await service.featuredDays(user), ...signinInfo(c, user), webhooks: await service.hooks.listEndpoints(user.id) }))
  })

  // Webhooks from /me: add, test, rotate, remove. /api/v1/webhooks does the same with a key.
  app.post('/me/webhooks/:action{(add|test|rotate|delete)}', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/me#webhooks')
    const form = (await c.req.parseBody()) as Record<string, string>
    const show = async (extra: { webhookNote: string; webhookSecret?: string }, status = 200) =>
      page(c, mePage(ctxOf(c), { user, products: store.mine(user.id), invite: store.inviteStats(user.id), karma: service.karma.summary(user.id), howToEarn: HOW_TO_EARN, featureDays: config.featureDays, daysBalance: await service.featuredDays(user), ...signinInfo(c, user), webhooks: await service.hooks.listEndpoints(user.id), profile: await (await profiles.ready).get(user.id), ...extra, webhookError: status !== 200 }), status)
    if (!hookLimit.allow(`hooks:${user.id}`)) return show({ webhookNote: 'Too many changes. Wait a few minutes.' }, 429)
    try {
      const action = c.req.param('action')
      if (action === 'add') {
        const r = await service.hooks.createEndpoint(user.id, { url: form.url ?? '', events: form.events?.trim() || undefined, description: form.description ?? '' })
        return show({ webhookNote: 'Webhook added. Copy its signing secret now; "New secret" replaces it.', webhookSecret: r.secret })
      }
      const id = form.id ?? ''
      if (action === 'test') {
        const r = await service.hooks.test(user.id, id)
        return show({ webhookNote: r.ok ? `Test delivered (HTTP ${r.status}).` : `Test failed: ${r.error ?? `HTTP ${r.status}`}` })
      }
      if (action === 'rotate') return show({ webhookNote: 'New signing secret below; the old one has stopped working.', webhookSecret: (await service.hooks.rotateSecret(user.id, id)).secret })
      await service.hooks.deleteEndpoint(user.id, id)
      return show({ webhookNote: 'Webhook removed.' })
    } catch (e) {
      const status = (e as { status?: number }).status
      return show({ webhookNote: e instanceof Error ? e.message : String(e) }, status && status >= 400 && status < 500 ? status : 400)
    }
  })

  // Invites: a link per member; a new member it brings in who launches earns the inviter a free Featured week.
  app.get('/i/:code', (c) => {
    const code = c.req.param('code')
    // A scarce invite code: whoever made it stays private until it is used.
    if (isInviteCode(code)) {
      if (!sessionUser(c)) setCookie(c, INVITE_COOKIE, code.trim().toUpperCase(), { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
      return page(c, inviteLanding(ctxOf(c), { inviter: null, bonusDays: INVITE_BONUS_DAYS }))
    }
    const inviter = store.inviterOf(code)
    if (!inviter) return c.redirect('/invite')
    if (!sessionUser(c)) setCookie(c, REF_COOKIE, code, { httpOnly: true, secure: secure(c), sameSite: 'Lax', path: '/', maxAge: 30 * 86400 })
    return page(c, inviteLanding(ctxOf(c), { inviter: store.publicName(inviter) }))
  })
  const inviteCodes = async (user: User) => ({ quota: await service.affiliates.quota(user.id), invites: await service.affiliates.invites(user.id), bonusDays: INVITE_BONUS_DAYS })
  const inviteView = async (c: Context<Env>, extra: { flash?: string; error?: string; newCode?: string } = {}, status = 200) => {
    const user = sessionUser(c)
    const me = user
      ? { link: inviteLink(user), stats: store.inviteStats(user.id), name: store.publicName(user.id), displayName: user.displayName, listings: store.mine(user.id).filter((p) => p.status === 'live'), codes: { ...(await inviteCodes(user)), newLink: extra.newCode ? `${origin}/i/${extra.newCode}` : undefined }, ...extra }
      : undefined
    return page(c, invitePage(ctxOf(c), { featureDays: config.featureDays, featureUsd: config.featureUsd, inviters: await inviters(10), me }), status)
  }
  app.get('/invite', (c) => inviteView(c))
  app.get('/invites', (c) => c.redirect('/invite#codes'))
  // A scarce invite code: three each, single use.
  app.post('/invite/code', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    if (crossSite(c)) return c.redirect('/invite')
    const note = String(((await c.req.parseBody()) as Record<string, string>).note ?? '').slice(0, 80)
    try {
      const invite = await service.affiliates.createInvite(user.id, note)
      return inviteView(c, { newCode: invite.code })
    } catch (e) {
      return inviteView(c, { error: (e as Error).message === 'no invites left' ? `You have used all ${INVITES_PER_PERSON} invite codes.` : (e as Error).message }, 400)
    }
  })
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
  app.get('/leaderboard', async (c) => {
    const user = sessionUser(c)
    const which = c.req.query('board') === 'invites' ? 'invites' : 'karma'
    // An empty week shows all time instead, so the board never opens blank.
    const period = (await rowsOf(which, 'week', 1)).length ? 'week' : 'all'
    return page(c, leaderboardPage(ctxOf(c), { board: which, period, featureDays: config.featureDays, featureUsd: config.featureUsd, perCredit: service.karma.perCredit, howToEarn: HOW_TO_EARN, me: user?.id ?? null }))
  })
  app.use('/leaderboard.json', leaderboard(board))
  app.use('/leaderboard/*', leaderboard(board))

  app.post('/p/:slug/vote', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return wantsJson(c) ? c.json({ error: 'no such product' }, 404) : c.notFound()
    if (crossSite(c)) return c.json({ error: 'vote from built.indie itself' }, 403)
    const counted = voteLimit.allow(`vote:${ip(c)}`) && service.vote(p, voter(c), sessionUser(c))
    const now = store.product(p.id)!
    if (wantsJson(c)) return c.json({ slug: now.slug, votes: now.votes, counted, voted: true })
    const back = c.req.header('referer')
    let to = `/p/${p.slug}`
    try {
      if (back && new URL(back).host === c.req.header('host')) to = new URL(back).pathname
    } catch {}
    return c.redirect(to)
  })

  // Comments, reviews and tracked shares: signed-in members, from this site only.
  const back = (p: Product, hash: string) => `/p/${p.slug}#${hash}`
  app.post('/p/:slug/comments', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = live(c.req.param('slug'))
    if (!p) return c.notFound()
    if (crossSite(c)) return c.redirect(back(p, 'comments'))
    if (!commentLimit.allow(`comment:${user.id}`)) return productView(c, p, { error: 'That is a lot of comments. Wait a few minutes.' }, 429)
    const form = (await c.req.parseBody()) as Record<string, string>
    try {
      const made = service.comment(p, user, form.body ?? '', form.parent || null)
      return c.redirect(back(p, `c-${made.id}`))
    } catch (e) {
      if (e instanceof InputError) return productView(c, p, { error: e.message }, 400)
      throw e
    }
  })
  app.post('/p/:slug/comments/:id/delete', (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = store.bySlug(c.req.param('slug'))
    if (!p) return c.notFound()
    if (crossSite(c)) return c.redirect(back(p, 'comments'))
    const cm = store.comment(c.req.param('id'))
    if (!cm || cm.productId !== p.id) return c.redirect(back(p, 'comments'))
    try {
      service.deleteComment(cm.id, user)
    } catch (e) {
      if (!(e instanceof InputError)) throw e
    }
    return c.redirect(back(p, 'comments'))
  })
  app.post('/p/:slug/review', async (c) => {
    const user = sessionUser(c)
    if (!user) return toLogin(c)
    const p = live(c.req.param('slug'))
    if (!p) return c.notFound()
    if (crossSite(c)) return c.redirect(back(p, 'reviews'))
    const form = (await c.req.parseBody()) as Record<string, string>
    try {
      if (form.action === 'delete') service.deleteReview(p, user.id)
      else service.review(p, user, form.rating, form.body)
      return c.redirect(back(p, 'reviews'))
    } catch (e) {
      if (e instanceof InputError) return productView(c, p, { error: e.message }, 400)
      throw e
    }
  })
  // A share button: app.js sends a beacon here before the share window opens.
  app.post('/p/:slug/share', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    if (crossSite(c)) return c.json({ error: 'share from built.indie itself' }, 403)
    const net = c.req.query('net') ?? ''
    if (!(SHARE_NETWORKS as readonly string[]).includes(net)) return c.json({ error: `net is one of ${SHARE_NETWORKS.join(', ')}` }, 400)
    if (!shareLimit.allow(`share:${ip(c)}`)) return c.json({ counted: false })
    return c.json(service.share(p, sessionUser(c), net))
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
      const user = sessionUser(c)
      const r = await service.feature(p, { email: form.email || user?.email || '', accountId: user?.id ?? null })
      return c.redirect(r.checkoutUrl, 303)
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
  const badgeImage = (c: Context<Env>, p: Product | null, unlisted = false) => {
    const theme = c.req.query('theme') === 'light' ? 'light' : 'dark'
    const shape = c.req.query('shape') === 'square' ? 'square' : 'wide'
    if (!p && unlisted) return c.body(launchBadgeSvg(theme, shape), 200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=3600', 'access-control-allow-origin': '*', 'cross-origin-resource-policy': 'cross-origin', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" })
    if (!p) return c.body('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', 404, { 'content-type': 'image/svg+xml' })
    return c.body(badgeSvg(p, store.awards(p.id), theme, shape), 200, {
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
  // A site with no listing (built.indie itself, a brand-new site) gets an invitation to launch instead.
  app.get('/for.svg', (c) => badgeImage(c, store.bySite(c.req.query('site') ?? ''), true))
  app.get('/for', (c) => {
    const p = store.bySite(c.req.query('site') ?? '')
    return c.redirect(p ? `/p/${p.slug}?ref=badge` : '/submit?ref=badge')
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
    const all = search(store.allLive(), parseQuery({}), { limit: 0 })
    const urls = ['/', '/search', '/tags', '/top/today', '/top/week', '/top/month', '/top/all', '/new', '/submit', '/help', '/invite', '/leaderboard', ...all.facets.category.map((f) => `/c/${f.value}`), ...store.tagCounts().map((t) => `/t/${encodeURIComponent(t.tag)}`), ...store.list('all', 5000).map((p) => `/p/${p.slug}`)]
    return c.body(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${origin}${u}</loc></url>`).join('')}</urlset>`, 200, { 'content-type': 'application/xml' })
  })
  app.get('/robots.txt', (c) => c.text(`User-agent: *\nAllow: /\nDisallow: /p/*/edit\nSitemap: ${origin}/sitemap.xml\n`))
  app.get('/llms.txt', (c) =>
    c.text(`# built.indie\n\n> Launch your indie product with one URL. built.indie reads your homepage (meta tags, Open Graph, JSON-LD, llms.txt, OpenSite, OpenProfile), saves the logo and screenshots, and puts it on a daily upvote board. Free, open source, no account.\n\n## API\n\n- [Help](${origin}/help): JSON API, CLI, TUI and MCP\n- [Today](${origin}/api/v1/products?window=today): today's launches as JSON\n- [Launch](${origin}/help#api): POST /api/v1/products {"url": "..."}\n- [MCP](${origin}/help#mcp): claude mcp add builtindie -- bunx @profullstack/builtindie mcp\n- [Install](${origin}/install.sh): curl -fsSL ${origin}/install.sh | sh\n- [Feed](${origin}/feed.xml): RSS of every launch\n- [Karma](${origin}/help#karma): members earn karma for launching, voting, reviewing, commenting and sharing; every ${service.karma.perCredit} karma is a free Featured week. GET /api/v1/karma (your key), GET /api/v1/leaderboard?board=karma&period=week\n- [Leaderboard](${origin}/leaderboard): top karma (default) and top inviters; JSON at /leaderboard/karma.json?period=week\n- [Comments and reviews](${origin}/help#api): GET/POST /api/v1/products/<slug>/comments, GET/POST /api/v1/products/<slug>/reviews, POST /api/v1/products/<slug>/share\n`),
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
    reviews: p.reviews,
    rating: p.rating,
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
    const tag = c.req.query('tag') !== undefined ? normalizeTag(c.req.query('tag')!) : undefined
    if (tag === null) return c.json({ error: 'tag is 2 to 24 letters, digits, spaces or + # . -' }, 400)
    if (!q && !tag && !WINDOWS.includes(w)) return c.json({ error: `window is one of ${WINDOWS.join(', ')}` }, 400)
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 30) || 30))
    const offset = Math.max(0, Number(c.req.query('offset') ?? 0) || 0)
    const products = tag ? store.byTag(tag, limit) : q ? search(store.allLive(), parseQuery({ q }), { limit }).products : store.list(w, limit, offset)
    return c.json({ window: tag ? 'tag' : q ? 'search' : w, ...(tag ? { tag } : {}), products: products.map(apiProduct) }, 200, { 'access-control-allow-origin': '*' })
  })

  // Search with facets: the browse page as data. Same parameters as /search.
  app.get('/api/v1/search', (c) => {
    const params = new URL(c.req.url).searchParams
    const limit = Math.min(100, Math.max(1, Number(params.get('limit') ?? 30) || 30))
    const r = search(store.allLive(), parseQuery(params), { limit })
    const qs = queryString(r.query)
    return c.json(
      {
        query: r.query,
        total: r.total,
        page: r.query.page,
        pages: Math.ceil(r.total / limit),
        products: r.products.map((p) => ({ ...apiProduct(p), categories: r.categories.get(p.id) ?? [] })),
        ...(params.get('facets') === '0' ? {} : { facets: r.facets }),
        web: `${origin}/search${qs ? `?${qs}` : ''}`,
      },
      200,
      { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=30' },
    )
  })
  app.get('/api/v1/categories', (c) => {
    const r = search(store.allLive(), parseQuery({}), { limit: 0 })
    return c.json({ categories: r.facets.category.map((f) => ({ key: f.value, label: f.label, count: f.count, page: `${origin}/c/${f.value}` })), tags: r.facets.tag.map((f) => ({ tag: f.value, count: f.count, page: `${origin}/t/${encodeURIComponent(f.value)}` })) }, 200, { 'access-control-allow-origin': '*' })
  })

  app.get('/api/v1/tags', (c) => c.json({ tags: store.tagCounts() }, 200, { 'access-control-allow-origin': '*' }))

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
      const b = await body(c)
      const user = apiUser(c)
      const r = await service.feature(p, { email: String(b.email ?? user?.email ?? ''), accountId: user?.id ?? null })
      return c.json({ checkout_url: r.checkoutUrl, checkout_session_id: r.sessionId, methods: r.methods, payment: r.ref, usd: config.featureUsd, days: config.featureDays })
    } catch (e) {
      return apiError(c, e)
    }
  })

  app.post('/api/v1/products/:slug/vote', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    if (crossSite(c)) return c.json({ error: 'vote from built.indie itself' }, 403)
    const counted = voteLimit.allow(`vote:${ip(c)}`) && service.vote(p, voter(c), apiUser(c))
    return c.json({ slug: p.slug, votes: store.product(p.id)!.votes, counted })
  })

  app.delete('/api/v1/products/:slug', async (c) => {
    // The maker deletes; an admin takes down (hidden, kept for the record).
    if (isAdmin(c)) {
      const p = store.bySlug(c.req.param('slug'))
      if (!p) return c.json({ error: 'no such product' }, 404)
      store.update(p.id, { status: 'hidden' })
      store.revokeInvite(p.id)
      service.karma.takenDown(p.id)
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
    return c.json({ owner: p.ownerId === user.id, record: claimRecord(p, user), badge: claimBadge(p, user), squareBadge: claimSquareBadge(p, user), markdown: claimMd(p, user) })
  })
  app.post('/api/v1/products/:slug/claim', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = store.bySlug(c.req.param('slug'))
    if (!p || p.status === 'hidden') return c.json({ error: 'no such product' }, 404)
    if (!readLimit.allow(`read:${ip(c)}`)) return c.json({ error: 'too many checks; wait a few minutes' }, 429)
    const r = await service.claim(p, user)
    return c.json({ claimed: r.ok, ...(r.method ? { method: r.method } : {}), looked: r.looked, record: claimRecord(p, user), badge: claimBadge(p, user), squareBadge: claimSquareBadge(p, user), ...(r.ok ? {} : { markdown: claimMd(p, user) }) })
  })
  mountProfileRoutes(app, {
    store: profiles.store,
    getUser: (_req: Request, c: Context) => {
      const user = sessionUser(c) ?? apiUser(c)
      return user ? { id: user.id, email: isPlaceholder(user.email) ? null : user.email } : null
    },
  })
  app.get('/api/v1/me', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    return c.json({ email: isPlaceholder(user.email) ? null : user.email, coinpay: Boolean(store.identities(user.id).some((i) => i.provider === COINPAY)), products: store.mine(user.id).map((p) => ({ ...apiProduct(p), owner: p.ownerId === user.id })), invite: await apiInvite(user), featured_days: await service.featuredDays(user), karma: apiKarma(user) })
  })
  const apiInvite = async (user: User) => {
    const s = store.inviteStats(user.id)
    const codes = await inviteCodes(user)
    return {
      link: inviteLink(user),
      code: s.code,
      invited: s.invited,
      launched: s.launched,
      credits: s.credits,
      karma_credits: s.karmaCredits,
      used: s.used,
      feature_days: config.featureDays,
      // Scarce single-use invite codes: the code itself is shown once, when made.
      invite_codes: { quota: codes.quota, bonus_days: codes.bonusDays, invites: codes.invites.map((i) => ({ id: i.id, note: i.note, created_at: new Date(i.createdAt).toISOString(), expires_at: i.expiresAt ? new Date(i.expiresAt).toISOString() : null, used: Boolean(i.usedAt), used_at: i.usedAt ? new Date(i.usedAt).toISOString() : null })) },
    }
  }
  app.get('/api/v1/invites', async (c) => {
    const user = apiUser(c)
    return user ? c.json(await apiInvite(user)) : c.json(NEEDS_ACCOUNT, 401)
  })
  app.post('/api/v1/invites', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    try {
      const invite = await service.affiliates.createInvite(user.id, String((await body(c)).note ?? '').slice(0, 80))
      return c.json({ link: `${origin}/i/${invite.code}`, code: invite.code, expires_at: invite.expiresAt ? new Date(invite.expiresAt).toISOString() : null, left: (await service.affiliates.quota(user.id)).left, bonus_days: INVITE_BONUS_DAYS }, 201)
    } catch (e) {
      return c.json({ error: (e as Error).message === 'no invites left' ? `You have used all ${INVITES_PER_PERSON} invite codes.` : (e as Error).message }, 400)
    }
  })
  app.post('/api/v1/redeem', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    if (!redeemLimit.allow(`redeem:${user.id}`) || !redeemLimit.allow(`redeem-ip:${ip(c)}`)) return c.json({ error: 'too many tries; wait a few minutes' }, 429)
    try {
      const r = await service.redeem(user, String((await body(c)).code ?? ''))
      return c.json({ ok: true, message: r.message, featured_days: r.days })
    } catch (e) {
      return apiError(c, e)
    }
  })
  app.post('/api/v1/products/:slug/feature-days', async (c) => {
    const user = apiUser(c)
    const p = owned(c)
    if (!user || !p) return c.json(NEEDS_KEY, 401)
    try {
      const after = await service.spendFeaturedDays(p, user, Number((await body(c)).days ?? 0))
      return c.json({ featured_until: new Date(after.featuredUntil!).toISOString(), featured_days: await service.featuredDays(user) })
    } catch (e) {
      return apiError(c, e)
    }
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

  // Customer webhooks: the @profullstack/webhooks API, scoped to the key's account.
  const hookOwner = new WeakMap<Request, string>()
  const hooksApi = webhooksApi(service.hooks, { basePath: '/api/v1/webhooks', owner: (req) => hookOwner.get(req) })
  const webhooksRoute = async (c: Context) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    if (c.req.method !== 'GET' && !hookLimit.allow(`hooks:${user.id}`)) return c.json({ error: 'too many changes; wait a few minutes' }, 429)
    hookOwner.set(c.req.raw, user.id)
    return (await hooksApi(c.req.raw)) ?? c.json({ error: 'not found' }, 404)
  }
  app.all('/api/v1/webhooks', webhooksRoute)
  app.all('/api/v1/webhooks/*', webhooksRoute)

  // Karma, comments, reviews, shares.
  const apiKarma = (user: User) => {
    const k = service.karma.summary(user.id)
    return { total: k.total, week: k.week, per_credit: k.perCredit, next_credit_in: k.nextCreditIn, credits: { earned: k.credits.granted, used: k.credits.used }, events: k.events.map((e) => ({ action: e.action, label: e.label, ref: e.ref, points: e.points, at: new Date(e.at).toISOString() })), how_to_earn: HOW_TO_EARN, leaderboard: `${origin}/leaderboard` }
  }
  app.get('/api/v1/karma', (c) => {
    const user = apiUser(c)
    return user ? c.json(apiKarma(user)) : c.json({ ...NEEDS_ACCOUNT, how_to_earn: HOW_TO_EARN, leaderboard: `${origin}/api/v1/leaderboard?board=karma&period=week` }, 401)
  })
  app.get('/api/v1/leaderboard', async (c) => {
    const which = c.req.query('board') === 'invites' ? 'invites' : 'karma'
    const period = (['week', 'month', 'all'] as const).find((x) => x === c.req.query('period')) ?? 'week'
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') ?? 25) || 25))
    const top = await board.top({ board: which, period, limit })
    return c.json({ board: which, period, total: top.total, rows: top.rows.map((r) => ({ rank: r.rank, id: r.id, name: r.name, value: r.value, badges: r.badges, url: `${origin}/leaderboard/u/${encodeURIComponent(r.id)}` })), web: `${origin}/leaderboard${which === 'karma' ? '' : '?board=invites'}` }, 200, { 'access-control-allow-origin': '*' })
  })
  const apiComment = (p: Product, x: CommentView) => ({ id: x.id, parent: x.parentId, body: x.deleted ? null : x.body, deleted: x.deleted, author: x.author || null, karma: x.karma, maker: x.maker, at: new Date(x.at).toISOString(), url: `${origin}/p/${p.slug}#c-${x.id}` })
  app.get('/api/v1/products/:slug/comments', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    return c.json({ slug: p.slug, comments: discussion(p, apiUser(c)).comments.map((x) => ({ ...apiComment(p, x), mine: x.mine })) }, 200, { 'access-control-allow-origin': '*' })
  })
  app.post('/api/v1/products/:slug/comments', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    if (!commentLimit.allow(`comment:${user.id}`)) return c.json({ error: 'too many comments; wait a few minutes' }, 429)
    const b = await body(c)
    try {
      const made = service.comment(p, user, String(b.body ?? b.text ?? ''), b.parent ? String(b.parent) : null)
      const view = discussion(p, user).comments.find((x) => x.id === made.id)!
      return c.json({ comment: apiComment(p, view), karma: store.karmaTotal(user.id) }, 201)
    } catch (e) {
      return apiError(c, e)
    }
  })
  app.delete('/api/v1/comments/:id', (c) => {
    const admin = isAdmin(c)
    const user = apiUser(c)
    if (!admin && !user) return c.json(NEEDS_ACCOUNT, 401)
    try {
      service.deleteComment(c.req.param('id'), user, admin)
      return c.json({ deleted: true })
    } catch (e) {
      return apiError(c, e)
    }
  })
  const apiReview = (x: ReviewView) => ({ rating: x.rating, body: x.body, author: x.author, karma: x.karma, at: new Date(x.at).toISOString() })
  app.get('/api/v1/products/:slug/reviews', (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    return c.json({ slug: p.slug, rating: p.rating, count: p.reviews, reviews: discussion(p, null).reviews.map(apiReview) }, 200, { 'access-control-allow-origin': '*' })
  })
  app.post('/api/v1/products/:slug/reviews', async (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    const b = await body(c)
    try {
      const r = service.review(p, user, b.rating, b.body ?? b.text ?? '')
      const now = store.product(p.id)!
      return c.json({ review: { rating: r.rating, body: r.body }, product: { rating: now.rating, count: now.reviews }, karma: store.karmaTotal(user.id) }, 201)
    } catch (e) {
      return apiError(c, e)
    }
  })
  app.delete('/api/v1/products/:slug/reviews', (c) => {
    const user = apiUser(c)
    if (!user) return c.json(NEEDS_ACCOUNT, 401)
    const p = store.bySlug(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    return c.json({ deleted: service.deleteReview(p, user.id) })
  })
  app.post('/api/v1/products/:slug/share', async (c) => {
    const p = live(c.req.param('slug'))
    if (!p) return c.json({ error: 'no such product' }, 404)
    const b = await body(c)
    try {
      if (!shareLimit.allow(`share:${ip(c)}`)) return c.json({ counted: false })
      return c.json(service.share(p, apiUser(c), String(b.network ?? c.req.query('net') ?? '')))
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
  return {
    origin: (env.BUILTINDIE_ORIGIN ?? PUBLIC_ORIGIN).replace(/\/+$/, ''),
    coinpay,
    featureUsd: Number(env.FEATURE_USD ?? 19),
    featureDays: Number(env.FEATURE_DAYS ?? 7),
    karmaPerCredit: Number(env.KARMA_PER_CREDIT ?? 500) || 500,
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
  const app = createApp({ service, auth: new Auth(store, mailer), adminKey: env.BUILTINDIE_ADMIN_KEY, mailer, coinpayOAuth: coinpayOAuthFromEnv(env) })
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
  // Customer webhooks: deliveries waiting from before the restart go out now, then every 5 s.
  service.hooks.start()
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
