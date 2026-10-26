/**
 * Server-rendered pages. One small script (public/app.js) votes without a page
 * load, copies snippets, shows progress while we read a site, and registers the
 * service worker; everything works without it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { InviteStats, Maker, Product, Review, User, Window } from './db.js'
import type { KarmaSummary } from './karma.js'
import { categorize, CATEGORY_LABELS, FACETS, isEmpty, queryString, SORTS, toggle, type Query, type Result } from './browse.js'
import { pitFooter } from './pit-footer.js'
import { RING_PLACEHOLDER } from './ring.js'
import { ringFooter, ringFooterOptions, setRingFooterOptions } from './ring-footer.js'
import { icon, SOCIAL_ICONS } from './icons.js'
import { COLUMNS as PROFILE_COLUMNS, renderProfileFields } from '@profullstack/profile'

export const REPO = 'https://github.com/moshcoder/built.indie'

// The footer's own links; the ring nav and copyright come from @profullstack/footer.
setRingFooterOptions(
  ringFooterOptions([
    { label: 'API · CLI · MCP', href: '/help' },
    { label: 'RSS', href: '/feed.xml' },
    { label: 'Source', href: REPO },
  ]),
)

/** crawlproof analytics on every page (project 71b194a4…); CRAWLPROOF_SITE=off turns it off. */
const TRACK_SITE = process.env.CRAWLPROOF_SITE ?? '71b194a4-9ae7-4b79-9ec1-0cf0d5ef203e'
const TRACKER = TRACK_SITE === 'off' ? '' : `<script data-site="${TRACK_SITE}" src="https://crawlproof.com/stats.js" async></script>`

/**
 * A crawlproof ad: a cross-origin, sandboxed iframe, so it can never read the
 * page. Only on pages where nobody is typing: never on submit or edit.
 * CRAWLPROOF_AD_SLOT overrides the slot; 'off' turns ads off.
 */
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? '7371269e-a3c9-4a84-8b22-00d5045068e7'
export const adUnit = () =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=text_link" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const enc = encodeURIComponent

/** The "Sign in with CoinPay" button: a plain link into the OAuth flow. */
const coinpayButton = (next: string | null, label = 'Sign in with CoinPay') => `<a class="btn ghost wide coinpay-btn" href="/api/v1/coinpay/login${next ? `?next=${enc(next)}` : ''}">${icon('dollar')} ${esc(label)}</a>`

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 5 17h7v11h8V17h7z" fill="currentColor"/></svg>`

export type Ctx = { origin: string; user?: User | null; voted?: (id: string) => boolean; /** Sign in with CoinPay is on. */ coinpay?: boolean }

type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; image?: string | null; head?: string; ads?: boolean; wide?: boolean; q?: string }

function layout(o: LayoutOptions): string {
  const url = o.ctx.origin + o.path
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(o.title)}</title>
<meta name="description" content="${esc(o.description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="built.indie">
<meta property="og:title" content="${esc(o.title)}">
<meta property="og:description" content="${esc(o.description)}">
<meta property="og:url" content="${esc(url)}">
${o.image ? `<meta property="og:image" content="${esc(o.image)}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="${esc(o.image)}">` : '<meta name="twitter:card" content="summary">'}
<meta name="referrer" content="strict-origin-when-cross-origin">
<meta name="color-scheme" content="dark light">
<meta name="theme-color" content="#0b0a10">
${o.noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(url)}">`}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<link rel="alternate" type="application/rss+xml" title="built.indie launches" href="/feed.xml">
<link rel="openprofile" href="/.well-known/openprofile.md">
<link rel="openicon" href="/icons/openicon.json">
<link rel="openstack" href="/.well-known/openstack.md">
${o.head ?? ''}
<link rel="stylesheet" href="${STYLE_URL}">
<script src="${SCRIPT_URL}" defer></script>
${TRACKER}
</head>
<body>
${RING_PLACEHOLDER}
<header class="top${o.wide ? ' wide' : ''}">
  <a class="brand" href="/">${LOGO}<span>built<b>.</b>indie</span></a>
  <form class="top-search" role="search" method="get" action="/search" data-suggest>
    <label class="sr" for="site-q">Search launches</label>
    <input id="site-q" name="q" type="search" placeholder="Search apps, tags, makers…" value="${esc(o.q ?? '')}" autocomplete="off" maxlength="80" enterkeyhint="search" aria-autocomplete="list" aria-controls="site-suggest"><kbd aria-hidden="true">/</kbd>
    <div class="suggest" id="site-suggest" role="listbox" hidden></div>
  </form>
  <nav aria-label="Site">
    <a href="/search">Browse</a>
    <a href="/top/today">Today</a>
    <a href="/top/week">Week</a>
    <a href="/new">New</a>
    <a href="/tags">Tags</a>
    <a href="/invite">Invite</a>
    <a href="/leaderboard">Leaderboard</a>
    <a href="/help">API</a>
    ${o.ctx.user ? '<a href="/me">Mine</a>' : '<a href="/login">Sign in</a>'}
    <a class="btn small-btn" href="/submit">${icon('rocket')} Launch</a>
  </nav>
</header>
<main${o.wide ? ' class="wide"' : ''}>
${o.ads ? adUnit() : ''}
${o.body}
</main>
${ringFooter()}
${pitFooter()}
</body>
</html>`
}

export const mediaUrl = (p: Product, file: string | null) => (file ? `/m/${p.id}/${file}` : null)
export const cardImage = (origin: string, p: Product) => {
  const f = p.ogImage ?? p.screenshot ?? p.images[0] ?? null
  return f ? `${origin}/m/${p.id}/${f}` : null
}

function logoImg(p: Product, size = 48): string {
  const src = mediaUrl(p, p.logo)
  return src
    ? `<img class="logo" src="${esc(src)}" width="${size}" height="${size}" alt="" loading="lazy">`
    : `<span class="logo logo-letter" style="width:${size}px;height:${size}px">${esc(p.name.slice(0, 1).toUpperCase())}</span>`
}

function voteButton(ctx: Ctx, p: Product, big = false): string {
  const voted = ctx.voted?.(p.id) ?? false
  return `<form class="vote-form" method="post" action="/p/${esc(p.slug)}/vote">
  <button class="vote${big ? ' big' : ''}${voted ? ' voted' : ''}" data-vote="${esc(p.slug)}" aria-label="Upvote ${esc(p.name)}"${voted ? ' aria-pressed="true"' : ''}><span class="arrow">${icon('arrow-up')}</span><span class="count">${p.votes}</span></button>
</form>`
}

function row(ctx: Ctx, p: Product, rank?: number): string {
  return `<li class="row-item">
  ${rank ? `<span class="rank">${rank}</span>` : ''}
  <a class="row-main" href="/p/${esc(p.slug)}">
    ${logoImg(p)}
    <span class="row-text"><b>${esc(p.name)}</b>${p.verifiedAt ? ' <span class="tick" title="Links back to built.indie">✓</span>' : ''}<span class="muted">${esc(p.tagline || p.domain)}</span>
    <span class="tags">${p.rating !== null ? `<span class="stars-mini" title="${p.rating} of 5 from ${p.reviews} review${p.reviews === 1 ? '' : 's'}">★ ${p.rating.toFixed(1)} <span class="muted">(${p.reviews})</span></span>` : ''}${categorize(p).slice(0, 1).filter((c) => c !== 'other').map((c) => `<span class="tag cat">${esc(CATEGORY_LABELS[c])}</span>`).join('')}${p.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span></span>
  </a>
  ${voteButton(ctx, p)}
</li>`
}

const board = (ctx: Ctx, products: Product[], ranked = true) => (products.length ? `<ol class="board">${products.map((p, i) => row(ctx, p, ranked ? i + 1 : undefined)).join('')}</ol>` : '')

function submitForm(compact = false, values: Record<string, string> = {}, error?: { message: string; field?: string }): string {
  return `<form class="submit-form${compact ? ' compact' : ''}" method="post" action="/submit" data-busy="Reading the homepage, llms.txt and manifest, saving the logo and screenshots…">
  ${error ? `<p class="note error" role="alert">${esc(error.message)}</p>` : ''}
  <label for="url"${compact ? ' class="sr"' : ''}>Your product’s URL</label>
  <div class="url-row"><input id="url" name="url" type="text" inputmode="url" autocomplete="url" placeholder="yourproduct.com" required value="${esc(values.url ?? '')}"${error?.field === 'url' ? ' aria-invalid="true"' : ''}><button class="btn">Launch it</button></div>
  ${compact ? '' : `<details${values.makerName || values.makerProfile ? ' open' : ''}><summary>Who made it? <span class="muted">(optional)</span></summary>
    <label for="makerName">Your name</label><input id="makerName" name="makerName" maxlength="60" value="${esc(values.makerName ?? '')}">
    <label for="makerProfile">Your OpenProfile.md <span class="muted">URL, e.g. yoursite.com/.well-known/openprofile.md (<a href="https://logicsrc.com/openprofile">what is it?</a>)</span></label><input id="makerProfile" name="makerProfile" type="text" inputmode="url" value="${esc(values.makerProfile ?? '')}"${error?.field === 'makerProfile' ? ' aria-invalid="true"' : ''}>
  </details>`}
  <p class="muted small">Free. We read the homepage: name, tagline, logo, screenshots, videos, socials, <code>llms.txt</code>, and the <a href="https://logicsrc.com/specs">LogicSRC</a> files: <code>opensite.json</code>, <code>openprofile.md</code>, <code>openstack.md</code>, <code>opensaas.json</code>, <code>openicon.json</code>. Anyone can launch any site; the owner claims it with the badge or a DNS record.</p>
</form>`
}

/** One inviter on a board: rank, public name, how many of their invitees launched, badges. */
export type InviterRow = { rank: number | null; id: string; name: string; value: number; badges: { emoji: string; label: string }[]; url: string }

function invitersList(rows: InviterRow[]): string {
  return `<ol class="board inviters">${rows
    .map((r) => `<li class="row-item"><span class="rank">${r.rank ?? ''}</span><a class="row-main" href="${esc(r.url)}"><span class="row-text"><b>${esc(r.name)}</b><span class="muted">${r.value} maker${r.value === 1 ? '' : 's'} launched ${r.badges.map((b) => `<span title="${esc(b.label)}">${esc(b.emoji)}</span>`).join('')}</span></span></a></li>`)
    .join('')}</ol>`
}

/** The invite offer, in one sentence, wherever it is promoted. */
export const inviteOffer = (days: number, usd: number) => `Every maker you invite who launches a listing earns you a free Featured week: ${days} days pinned above today’s board (a $${usd} spot). No cap.`

function invitePromo(ctx: Ctx, d: { inviters: InviterRow[]; featureDays: number; featureUsd: number }): string {
  return `<section class="card invite-promo" id="invite">
  <div>
    <h2>${icon('star')} Invite a maker, get Featured free</h2>
    <p class="muted">${esc(inviteOffer(d.featureDays, d.featureUsd))}</p>
    <p class="row"><a class="btn small-btn" href="${ctx.user ? '/invite' : '/login?next=/invite'}">Get your invite link</a><a class="chip" href="/leaderboard">${icon('trophy')} Top inviters</a></p>
  </div>
  <div><h3 class="mini-h">Top inviters this week</h3>${d.inviters.length ? invitersList(d.inviters) : '<p class="muted small">Nobody yet. Invite one maker who launches and you top the board.</p>'}</div>
</section>`
}

/** Karma rows: rank, public name, karma, badges. */
function karmaList(rows: InviterRow[]): string {
  return `<ol class="board inviters">${rows
    .map((r) => `<li class="row-item"><span class="rank">${r.rank ?? ''}</span><a class="row-main" href="${esc(r.url)}"><span class="row-text"><b>${esc(r.name)}</b><span class="muted"><span class="karma">${r.value} karma</span> ${r.badges.map((b) => `<span title="${esc(b.label)}">${esc(b.emoji)}</span>`).join('')}</span></span></a></li>`)
    .join('')}</ol>`
}

/** The "how to earn" table, wherever karma is explained. */
export function howToEarnTable(rows: { action: string; points: number; rule: string }[]): string {
  return `<table class="earn"><thead><tr><th scope="col">Do this</th><th scope="col">Karma</th><th scope="col">Rule</th></tr></thead><tbody>${rows.map((r) => `<tr><td>${esc(r.action)}</td><td class="pts">+${r.points}</td><td class="muted small">${esc(r.rule)}</td></tr>`).join('')}</tbody></table>`
}

function karmaPromo(ctx: Ctx, d: { karma: { period: 'week' | 'all'; rows: InviterRow[] }; featureDays: number }): string {
  return `<section class="card invite-promo karma-promo" id="karma">
  <div>
    <h2>${icon('trophy')} Earn karma, get Featured free</h2>
    <p class="muted">Launch, upvote, review, comment and share to earn karma. Every 500 karma is a free Featured week (${d.featureDays} days pinned on the homepage).</p>
    <p class="row"><a class="btn small-btn" href="${ctx.user ? '/me#karma' : '/login?next=/me'}">${ctx.user ? 'Your karma' : 'Sign in to earn'}</a><a class="chip" href="/leaderboard">${icon('trophy')} Leaderboard</a></p>
  </div>
  <div><h3 class="mini-h">${d.karma.period === 'week' ? 'Top karma this week' : 'Top karma of all time'}</h3>${d.karma.rows.length ? karmaList(d.karma.rows) : `<p class="muted small">Nobody yet. <a href="${ctx.user ? '/top/today' : '/login?next=/top/today'}">Upvote a launch</a> and you top the board.</p>`}</div>
</section>`
}

export function homePage(ctx: Ctx, d: { today: Product[]; featured: Product[]; yesterday: Product[]; stats: { products: number; votes: number }; inviters: InviterRow[]; karma: { period: 'week' | 'all'; rows: InviterRow[] }; featureDays: number; featureUsd: number }): string {
  return layout({
    ctx,
    title: 'built.indie: launch your indie product with one URL',
    description: 'Paste a URL. We fetch everything: logo, screenshots, videos, llms.txt. Get upvotes and a badge. Free.',
    path: '/',
    body: `<section class="hero">
  <h1>Built it? Launch it.</h1>
  <p class="lede">Paste one URL. We pull your logo, screenshots, videos and story from your homepage. People upvote. You get a badge.</p>
  ${submitForm(true)}
  <p class="muted small">${d.stats.products} launched · ${d.stats.votes} upvotes · free, no sign-up to launch</p>
</section>
${karmaPromo(ctx, d)}
${invitePromo(ctx, d)}
${d.featured.length ? `<h2 class="section-h">Featured</h2>${board(ctx, d.featured, false)}` : ''}
<h2 class="section-h">Launching today <span class="muted small">resets at 00:00 UTC</span></h2>
${board(ctx, d.today) || `<p class="empty">Nothing launched yet today. <a href="/submit">Be first</a>: first launch of the day gets the top spot until someone beats it.</p>`}
${d.yesterday.length ? `<h2 class="section-h">Yesterday’s winners</h2>${board(ctx, d.yesterday.slice(0, 3))}` : ''}
<p class="center"><a href="/top/week">This week</a> · <a href="/top/month">This month</a> · <a href="/top/all">All time</a> · <a href="/new">Newest</a></p>`,
  })
}

const WINDOW_TITLES: Record<Window, string> = { today: 'Top today', week: 'Top this week', month: 'Top this month', all: 'Top of all time', new: 'Newest launches', featured: 'Featured' }

export function boardPage(ctx: Ctx, window: Window, products: Product[]): string {
  const tabs = (['today', 'week', 'month', 'all', 'new'] as Window[]).map((w) => `<a href="${w === 'new' ? '/new' : `/top/${w}`}"${w === window ? ' aria-current="page"' : ''}>${esc(WINDOW_TITLES[w].replace(/^Top (this )?|^Top of /, '').replace(/^Newest launches$/, 'New'))}</a>`).join('')
  return layout({
    ctx,
    title: `${WINDOW_TITLES[window]} · built.indie`,
    description: `${WINDOW_TITLES[window]}: indie products launched on built.indie.`,
    path: window === 'new' ? '/new' : `/top/${window}`,
    ads: true,
    body: `<h1 class="page-h">${esc(WINDOW_TITLES[window])}</h1>
<nav class="tabs" aria-label="Boards">${tabs}<a href="/search">Browse &amp; filter</a></nav>
${board(ctx, products, window !== 'new') || '<p class="empty">Nothing here yet.</p>'}`,
  })
}

/** Every tag, sized by how many launches carry it. */
export function tagsPage(ctx: Ctx, tags: { tag: string; count: number }[]): string {
  const max = Math.max(1, ...tags.map((t) => t.count))
  return layout({
    ctx,
    title: 'Tags · built.indie',
    description: 'Browse indie products launched on built.indie by topic.',
    path: '/tags',
    body: `<h1 class="page-h">Tags</h1>
<p class="muted">Every tag, sized by use. <a href="/search">Browse with filters</a> to combine tags, categories and more.</p>
${tags.length ? `<p class="tag-cloud">${tags.map((t) => `<a class="tag" href="/t/${enc(t.tag)}" style="font-size:${(0.8 + (0.7 * t.count) / max).toFixed(2)}rem">${esc(t.tag)} <span class="muted">${t.count}</span></a>`).join('')}</p>` : '<p class="empty">No tags yet.</p>'}`,
  })
}

const searchHref = (q: Query) => {
  const s = queryString(q)
  return s ? `/search?${s}` : '/search'
}

/** The facet rail: every value is a link that switches it on or off, with how many it would show. */
function facetRail(r: Result): string {
  const groups = FACETS.map((f) => {
    const values = r.facets[f.name]
    if (!values.length) return ''
    const selected = f.name === 'launched' ? (r.query.launched ? [r.query.launched] : []) : r.query[f.name]
    const open = ['category', 'launched', 'has'].includes(f.name) || selected.length > 0
    return `<details class="facet-group"${open ? ' open' : ''}><summary>${esc(f.label)}${selected.length ? ` <span class="facet-n">${selected.length}</span>` : ''}</summary><ul>${values
      .map((v) => {
        const on = selected.includes(v.value)
        return `<li><a class="facet-item${on ? ' on' : ''}" href="${esc(searchHref(toggle(r.query, f.name, v.value)))}" rel="nofollow"${on ? ' aria-current="true"' : ''}><span class="facet-check${f.multi ? '' : ' radio'}" aria-hidden="true"></span><span class="facet-label">${esc(v.label)}</span><span class="facet-count">${v.count}</span></a></li>`
      })
      .join('')}</ul></details>`
  }).join('')
  return groups || '<p class="muted small">Nothing to narrow yet.</p>'
}

function chipsHtml(r: Result): string {
  if (!r.chips.length) return ''
  return `<ul class="chips">${r.chips
    .map((c) => `<li><a class="chip on" href="${esc(searchHref(c.facet === 'q' ? { ...r.query, q: '', sort: r.query.sort === 'relevance' ? 'top' : r.query.sort, page: 1 } : toggle(r.query, c.facet, c.value)))}" rel="nofollow" aria-label="Remove ${esc(c.label)}">${esc(c.label)} <span aria-hidden="true">×</span></a></li>`)
    .join('')}<li><a class="chip clear" href="/search">Clear all</a></li></ul>`
}

function pager(r: Result): string {
  const pages = Math.ceil(r.total / r.limit)
  if (pages <= 1) return ''
  const at = r.query.page
  return `<nav class="pager" aria-label="Pages">${at > 1 ? `<a class="chip" href="${esc(searchHref({ ...r.query, page: at - 1 }))}" rel="prev">← Previous</a>` : ''}<span class="muted small">Page ${at} of ${pages}</span>${at < pages ? `<a class="chip" href="${esc(searchHref({ ...r.query, page: at + 1 }))}" rel="next">Next →</a>` : ''}</nav>`
}

/**
 * Browse and search: the facet rail, what is switched on, and the results.
 * /search takes any combination; /c/<category> and /t/<tag> are the same page
 * for one filter, under an address worth indexing.
 */
export function browsePage(ctx: Ctx, r: Result, d: { path: string; heading?: string; intro?: string } = { path: '/search' }): string {
  const q = r.query
  const what = r.chips.map((c) => c.label).join(' · ')
  const heading = d.heading ?? (isEmpty(q) ? 'Browse every launch' : q.q && r.chips.length === 1 ? `Search: ${q.q}` : what)
  const hidden = (k: string, v: string) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`
  const keep = [
    ...(q.q ? [hidden('q', q.q)] : []),
    ...(['category', 'tag', 'has', 'stack', 'maker'] as const).flatMap((k) => q[k].map((v) => hidden(k, v))),
    ...(q.launched ? [hidden('launched', q.launched)] : []),
  ].join('')
  return layout({
    ctx,
    title: `${heading} (${r.total}) · built.indie`,
    description: d.intro ?? `${r.total} indie launch${r.total === 1 ? '' : 'es'}${what ? ` matching ${what}` : ''}. Filter by category, tag, stack, maker and more.`,
    path: d.path,
    // Filter combinations are endless; only the plain pages are worth indexing.
    noindex: d.path === '/search' && !isEmpty(q),
    ads: true,
    wide: true,
    q: q.q,
    body: `<div class="browse">
<details class="facets" open data-facets>
  <summary class="facets-toggle">Filters${r.chips.filter((c) => c.facet !== 'q').length ? ` <span class="facet-n">${r.chips.filter((c) => c.facet !== 'q').length}</span>` : ''}</summary>
  <div class="facet-rail">${facetRail(r)}</div>
</details>
<section class="results">
  <header class="results-head">
    <div><h1 class="page-h">${esc(heading)}</h1><p class="muted small">${r.total} launch${r.total === 1 ? '' : 'es'}${d.intro ? ` · ${esc(d.intro)}` : ''}</p></div>
    <form class="sort-form" method="get" action="/search" data-autosubmit>${keep}<label class="sr" for="sort">Sort by</label><select id="sort" name="sort">${(Object.keys(SORTS) as (keyof typeof SORTS)[])
      .filter((s) => s !== 'relevance' || q.q)
      .map((s) => `<option value="${s}"${q.sort === s ? ' selected' : ''}>${esc(SORTS[s])}</option>`)
      .join('')}</select><noscript><button class="chip">Sort</button></noscript></form>
  </header>
  ${chipsHtml(r)}
  ${board(ctx, r.products, false) || `<p class="empty">Nothing matches all of that. Remove a filter, or <a href="/search">start over</a>.${q.q ? ` Or <a href="/submit?url=${enc(q.q)}">launch it</a> if it is yours.` : ''}</p>`}
  ${pager(r)}
</section>
</div>`,
  })
}

/** Share intents. Each click sends a beacon to /p/<slug>/share?net=… first (app.js): a signed-in member earns karma. */
function share(origin: string, p: Product): string {
  const url = `${origin}/p/${p.slug}`
  const text = `${p.name}: ${p.tagline || p.domain}. Launched on built.indie, upvote it 👇`
  const links: [string, string, string, string][] = [
    ['X', 'x', 'x', `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`],
    ['Bluesky', 'bluesky', 'bluesky', `https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}`],
    ['Mastodon', 'mastodon', 'share', `https://mastodonshare.com/?text=${enc(text)}&url=${enc(url)}`],
    ['LinkedIn', 'linkedin', 'linkedin', `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`],
    ['Reddit', 'reddit', 'reddit', `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(`${p.name}: ${p.tagline}`)}`],
    ['Hacker News', 'hn', 'code', `https://news.ycombinator.com/submitlink?u=${enc(p.url)}&t=${enc(`Show HN: ${p.name} – ${p.tagline}`)}`],
  ]
  return `<div class="share" data-share-slug="${esc(p.slug)}">${links.map(([n, net, ic, h]) => `<a class="chip" href="${esc(h)}" target="_blank" rel="noopener" data-share="${net}">${icon(ic)} ${esc(n)}</a>`).join('')}<button class="chip" data-copy="${esc(url)}" data-share="copy">${icon('link')} Copy link</button></div>`
}

/** A comment or review as the page shows it: the public name and karma, never the email. */
export type CommentView = { id: string; parentId: string | null; body: string; deleted: boolean; at: number; author: string; karma: number; maker: boolean; mine: boolean }
export type ReviewView = { rating: number; body: string; at: number; author: string; karma: number; mine: boolean }

const when = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const stars = (n: number) => `<span class="stars" aria-label="${n} of 5 stars">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`
/** Paragraphs from plain text: escaped, line breaks kept. */
const prose = (t: string) => t.split(/\n{2,}/).map((para) => `<p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('')
const byline = (name: string, karma: number, extra = '') => `<b class="who">${esc(name)}</b> <span class="karma" title="Karma">${karma} karma</span>${extra}`

function reviewsHtml(ctx: Ctx, p: Product, reviews: ReviewView[], mine: Review | null, self: boolean): string {
  const form = !ctx.user
    ? `<p class="muted small"><a href="/login?next=${enc(`/p/${p.slug}#reviews`)}">Sign in</a> to review it (+5 karma for stars and a few sentences).</p>`
    : self
      ? '<p class="muted small">This is your listing: reviews come from everyone else.</p>'
      : `<form method="post" action="/p/${esc(p.slug)}/review" class="review-form">
  <fieldset class="rate"><legend>${mine ? 'Your review' : 'Rate it'}</legend>${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="rate-${n}" name="rating" value="${n}"${mine?.rating === n ? ' checked' : ''} required><label for="rate-${n}" title="${n} star${n === 1 ? '' : 's'}">★</label>`).join('')}</fieldset>
  <label for="review-body" class="sr">Your review</label><textarea id="review-body" name="body" rows="3" maxlength="2000" placeholder="What is it like to use? (30 characters or more earns karma)">${esc(mine?.body ?? '')}</textarea>
  <div class="row"><button class="btn small-btn">${mine ? 'Update review' : 'Post review'}</button>${mine ? '<button class="chip danger" name="action" value="delete" formnovalidate>Delete</button>' : ''}</div>
</form>`
  return `<section class="card discuss" id="reviews">
  <h2 class="mini-h">${icon('star')} Reviews ${p.rating !== null ? `<span class="muted small">${stars(Math.round(p.rating))} ${p.rating.toFixed(1)} from ${p.reviews}</span>` : ''}</h2>
  ${reviews.length ? `<ul class="thread">${reviews.map((r) => `<li class="post"><header>${stars(r.rating)} ${byline(r.author, r.karma, r.mine ? ' <span class="pill">you</span>' : '')} <time class="muted small" datetime="${new Date(r.at).toISOString()}">${when(r.at)}</time></header>${r.body ? `<div class="body">${prose(r.body)}</div>` : ''}</li>`).join('')}</ul>` : '<p class="muted small">No reviews yet.</p>'}
  ${form}
</section>`
}

function commentsHtml(ctx: Ctx, p: Product, comments: CommentView[]): string {
  const top = comments.filter((c) => !c.parentId)
  const replies = (id: string) => comments.filter((c) => c.parentId === id)
  const del = (c: CommentView) => (c.mine && !c.deleted ? `<form method="post" action="/p/${esc(p.slug)}/comments/${esc(c.id)}/delete" class="inline" data-confirm="Delete this comment?"><button class="linkish small">delete</button></form>` : '')
  const one = (c: CommentView) =>
    c.deleted
      ? `<article class="post deleted" id="c-${esc(c.id)}"><p class="muted small">[deleted]</p></article>`
      : `<article class="post" id="c-${esc(c.id)}"><header>${byline(c.author, c.karma, c.maker ? ' <span class="pill ok">maker</span>' : '')} <a class="muted small" href="#c-${esc(c.id)}"><time datetime="${new Date(c.at).toISOString()}">${when(c.at)}</time></a> ${del(c)}</header><div class="body">${prose(c.body)}</div></article>`
  const box = (parent?: string) =>
    ctx.user
      ? `<form method="post" action="/p/${esc(p.slug)}/comments" class="comment-form">${parent ? `<input type="hidden" name="parent" value="${esc(parent)}">` : ''}<label class="sr" for="cb-${parent ?? 'new'}">${parent ? 'Reply' : 'Comment'}</label><textarea id="cb-${parent ?? 'new'}" name="body" rows="${parent ? 2 : 3}" maxlength="2000" required placeholder="${parent ? 'Reply…' : 'Ask the maker something, or say what you think'}"></textarea><button class="${parent ? 'chip' : 'btn small-btn'}">${parent ? 'Reply' : 'Comment'}</button></form>`
      : ''
  return `<section class="card discuss" id="comments">
  <h2 class="mini-h">${icon('user')} Comments <span class="muted small">${comments.filter((c) => !c.deleted).length}</span></h2>
  ${top.length ? `<ol class="thread">${top.map((c) => `<li>${one(c)}${replies(c.id).length ? `<ol class="thread replies">${replies(c.id).map((r) => `<li>${one(r)}</li>`).join('')}</ol>` : ''}${ctx.user && !c.deleted ? `<details class="reply"><summary class="small">Reply</summary>${box(c.id)}</details>` : ''}</li>`).join('')}</ol>` : '<p class="muted small">No comments yet. Start the conversation.</p>'}
  ${ctx.user ? box() : `<p class="muted small"><a href="/login?next=${enc(`/p/${p.slug}#comments`)}">Sign in</a> to comment (+2 karma).</p>`}
</section>`
}

/** schema.org data for search engines; the rating only once someone has reviewed it. */
function productJsonLd(origin: string, p: Product, reviews: ReviewView[]): string {
  const data: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: p.name,
    description: p.tagline || p.description || undefined,
    url: p.url,
    applicationCategory: 'WebApplication',
    ...(cardImage(origin, p) ? { image: cardImage(origin, p) } : {}),
    ...(p.rating !== null && p.reviews ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: p.rating, reviewCount: p.reviews, bestRating: 5, worstRating: 1 } } : {}),
    ...(reviews.length ? { review: reviews.slice(0, 5).map((r) => ({ '@type': 'Review', author: { '@type': 'Person', name: r.author }, reviewRating: { '@type': 'Rating', ratingValue: r.rating, bestRating: 5 }, ...(r.body ? { reviewBody: r.body } : {}), datePublished: when(r.at) })) } : {}),
  }
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`
}

export function badgeSnippet(origin: string, p: Product): string {
  return `<a href="${origin}/p/${p.slug}?ref=badge"><img src="${origin}/badge/${p.slug}.svg" alt="${p.name} on built.indie" width="200" height="44"></a>`
}

/** The badge with this account's badge id on it: placed on the homepage, it claims the listing (and earns the ✓). */
export function claimBadgeSnippet(origin: string, p: Product, badgeId: string): string {
  return `<a href="${origin}/p/${p.slug}"><img src="${origin}/images.svg?id=${badgeId}" alt="Launched on built.indie" width="200" height="44"></a>`
}

/** "Built with", from the product's own OpenStack.md. */
function stackHtml(p: Product): string {
  const s = p.extras.stack
  if (!s) return ''
  const layers = new Map<string, string[]>()
  for (const i of s.items) layers.set(i.layer, [...(layers.get(i.layer) ?? []), i.name])
  return `<div class="stack"><h2 class="mini-h">${icon('layers')} Built with</h2>${[...layers].slice(0, 8).map(([layer, names]) => `<p><span class="muted small">${esc(layer)}</span> ${names.slice(0, 8).map((n) => `<span class="tag">${esc(n)}</span>`).join(' ')}</p>`).join('')}</div>`
}

/** Plans and the way out, from the product's own OpenSaaS file. */
function pricingHtml(p: Product): string {
  const s = p.extras.pricing
  if (!s) return ''
  const price = (n: number | null) => (n === null ? '' : n === 0 ? 'Free' : `${s.currency === 'USD' ? '$' : `${s.currency} `}${n}`)
  return `<div class="pricing"><h2 class="mini-h">${icon('dollar')} Pricing</h2><ul class="plans">${s.plans.map((pl) => `<li><b>${pl.url ? `<a href="${esc(pl.url)}" rel="nofollow noopener">${esc(pl.name)}</a>` : esc(pl.name)}</b> ${esc(price(pl.price))}${pl.period && pl.price ? `/${esc(pl.period)}` : ''}${pl.trial ? ` <span class="muted small">· ${esc(pl.trial)} trial</span>` : ''}</li>`).join('')}</ul>${s.cancel ? `<p class="small muted">The way out: <a href="${esc(s.cancel)}" rel="nofollow noopener">cancel page</a></p>` : ''}</div>`
}

const SOCIAL_LABELS: Record<string, string> = { x: 'X', github: 'GitHub', linkedin: 'LinkedIn', discord: 'Discord', youtube: 'YouTube', bluesky: 'Bluesky', instagram: 'Instagram', tiktok: 'TikTok', reddit: 'Reddit', telegram: 'Telegram', producthunt: 'Product Hunt', appstore: 'App Store', playstore: 'Google Play', chrome: 'Chrome Web Store' }

export function productPage(ctx: Ctx, d: { comments?: CommentView[]; reviews?: ReviewView[]; myReview?: Review | null; selfListing?: boolean; error?: string; product: Product; award: { day: string; rank: number } | null; maker: Maker | null; featuredOk?: boolean; featuredCredit?: boolean; launched?: boolean; canEdit?: boolean; credits?: number; buyerEmail?: string; featureUsd: number; featureDays: number; payments: boolean }): string {
  const p = d.product
  const shots = [p.screenshot, ...p.images, p.ogImage].filter((f): f is string => Boolean(f))
  const rel = p.verifiedAt ? 'noopener' : 'noopener nofollow ugc'
  const live = p.status === 'live'
  const awardText = d.award ? `#${d.award.rank} Product of the day · ${d.award.day}` : ''
  return layout({
    ctx,
    title: `${p.name}: ${p.tagline || p.domain} · built.indie`,
    description: p.description || p.tagline || `${p.name} on built.indie`,
    path: `/p/${p.slug}`,
    image: cardImage(ctx.origin, p),
    noindex: !live,
    ads: live,
    head: `<link rel="opensite" href="/p/${esc(p.slug)}/opensite.json"><link rel="alternate" type="text/markdown" title="OpenProfile" href="/p/${esc(p.slug)}/openprofile.md">${live ? productJsonLd(ctx.origin, p, d.reviews ?? []) : ''}`,
    body: `${d.error ? `<p class="note error" role="alert">${esc(d.error)}</p>` : ''}${d.launched && live ? `<div class="note launched"><b>🚀 ${esc(p.name)} is live.</b> Today’s board resets at midnight UTC: share it now. ${p.ownerId ? '' : `Is it yours? <a href="/p/${esc(p.slug)}/claim">Claim it</a> with your badge (or a DNS record) to edit it and get the ✓.`}</div>` : ''}
${d.featuredOk ? '<p class="note">Thanks! Your payment is on its way; the Featured spot starts the moment CoinPay confirms it.</p>' : ''}
${d.featuredCredit ? `<p class="note launched">★ Featured for ${d.featureDays} more days with an invite credit. <a href="/invite">Invite another maker</a> to earn the next one.</p>` : ''}
${!live ? `<p class="note">${p.status === 'draft' ? 'Draft: only people with the edit link see this.' : 'Taken down.'}</p>` : ''}
<section class="product-head">
  ${logoImg(p, 72)}
  <div class="product-title">
    <h1>${esc(p.name)}</h1>
    <p class="lede">${esc(p.tagline)}</p>
    <p class="badges">${awardText ? `<span class="pill gold">🏆 ${esc(awardText)}</span>` : ''}${p.featuredUntil && p.featuredUntil > Date.now() ? '<span class="pill">★ Featured</span>' : ''}${p.verifiedAt ? '<span class="pill ok" title="Their homepage links back to built.indie">✓ Verified</span>' : ''}${p.rating !== null ? `<a class="pill" href="#reviews">★ ${p.rating.toFixed(1)} · ${p.reviews} review${p.reviews === 1 ? '' : 's'}</a>` : ''}${p.llms ? `<a class="pill" href="${esc(p.llms.url)}" rel="nofollow noopener">llms.txt</a>` : ''}${p.profile ? `<a class="pill" href="${esc(p.profile.url)}" rel="nofollow noopener">OpenProfile</a>` : ''}${p.record?.source === 'declared' ? '<span class="pill">OpenSite</span>' : ''}${p.extras.stack ? `<a class="pill" href="${esc(p.extras.stack.url)}" rel="nofollow noopener">OpenStack</a>` : ''}${p.extras.pricing ? `<a class="pill" href="${esc(p.extras.pricing.url)}" rel="nofollow noopener">OpenSaaS</a>` : ''}${p.extras.openicon ? `<a class="pill" href="${esc(p.extras.openicon)}" rel="nofollow noopener">OpenIcon</a>` : ''}</p>
  </div>
  <div class="product-actions">
    ${live ? voteButton(ctx, p, true) : ''}
    <a class="btn ghost" href="${esc(p.url)}" rel="${rel}" target="_blank">Visit ${esc(p.domain)} ${icon('external-link')}</a>
    ${d.canEdit ? `<a class="chip" href="/p/${esc(p.slug)}/edit">Edit</a>` : p.ownerId ? '<span class="muted small">Claimed by its owner</span>' : `<a class="chip" href="/p/${esc(p.slug)}/claim">Is this yours? Claim it</a>`}
  </div>
</section>
${shots.length ? `<div class="gallery">${shots.map((f, i) => `<a href="${esc(mediaUrl(p, f)!)}" target="_blank"><img src="${esc(mediaUrl(p, f)!)}" alt="${esc(p.name)} screenshot ${i + 1}" loading="${i ? 'lazy' : 'eager'}"></a>`).join('')}</div>` : ''}
${p.videos.length ? `<div class="videos">${p.videos.map((v) => (v.embed ? `<div class="video"><iframe src="${esc(v.embed)}" title="${esc(p.name)} video" loading="lazy" allow="fullscreen; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation"></iframe></div>` : `<p><a href="${esc(v.url)}" rel="nofollow noopener" target="_blank">▶ Watch the video</a></p>`)).join('')}</div>` : ''}
<div class="card">
  ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
  <p class="tags">${categorize(p).map((c) => `<a class="tag cat" href="/c/${esc(c)}">${esc(CATEGORY_LABELS[c])}</a>`).join('')}${p.tags.map((t) => `<a class="tag" href="/t/${enc(t)}">${esc(t)}</a>`).join('')}</p>
  ${Object.keys(p.socials).length ? `<p class="socials">${Object.entries(p.socials).map(([k, v]) => `<a class="chip" href="${esc(v)}" rel="nofollow noopener" target="_blank">${icon(SOCIAL_ICONS[k] ?? 'globe')} ${esc(SOCIAL_LABELS[k] ?? k)}</a>`).join('')}</p>` : ''}
  ${stackHtml(p)}
  ${pricingHtml(p)}
  ${p.makerName || d.maker ? `<p class="maker">Made by ${d.maker ? `<a href="/makers/${esc(d.maker.id)}">${esc(p.makerName || d.maker.name)}</a>${p.makerVerified ? ' <span class="tick" title="Their OpenProfile names this product">✓</span>' : ''}` : esc(p.makerName)}</p>` : ''}
  <p class="muted small">Launched ${p.launchedAt ? new Date(p.launchedAt).toISOString().slice(0, 10) : 'soon'} · ${p.votes} upvote${p.votes === 1 ? '' : 's'} · <a href="/p/${esc(p.slug)}/opensite.json">OpenSite record</a> · <a href="/p/${esc(p.slug)}/openprofile.md">OpenProfile.md</a></p>
</div>
${live ? `${reviewsHtml(ctx, p, d.reviews ?? [], d.myReview ?? null, Boolean(d.selfListing))}
${commentsHtml(ctx, p, d.comments ?? [])}
<h2 class="section-h">Share it</h2>${share(ctx.origin, p)}
<details class="card" id="badge"${p.verifiedAt || !d.canEdit ? '' : ' open'}>
  <summary>Add the badge to your site</summary>
  <p class="muted">Put this on your homepage. It shows your live upvote count, and once we see it your link here becomes a followed link and you get the ✓.</p>
  <p><img src="/badge/${esc(p.slug)}.svg" alt="badge" width="200" height="44"> <img src="/badge/${esc(p.slug)}.svg?theme=light" alt="badge, light" width="200" height="44"></p>
  <pre><code>${esc(badgeSnippet(ctx.origin, p))}</code></pre>
  <div class="row"><button class="chip" data-copy="${esc(badgeSnippet(ctx.origin, p))}">Copy badge HTML</button><form method="post" action="/p/${esc(p.slug)}/verify"><button class="chip">I added it: check</button></form></div>
</details>
${d.payments || d.canEdit ? `<details class="card" id="feature"${d.canEdit && d.credits ? ' open' : ''}><summary>Feature it: ${esc(`$${d.featureUsd}`)} for ${d.featureDays} days, or free with an invite</summary>
  <p class="muted">Pinned above today’s board on the homepage for ${d.featureDays} days.</p>
  ${d.canEdit && d.credits ? `<form method="post" action="/p/${esc(p.slug)}/credit" class="row"><button class="btn">${icon('star')} Use a free invite credit</button><span class="muted small">${d.credits} left</span></form>` : `<p class="muted small">Free: ${esc(inviteOffer(d.featureDays, d.featureUsd))} <a href="/invite">Get your invite link</a>.</p>`}
  ${d.payments ? `<form method="post" action="/p/${esc(p.slug)}/feature" class="row"><label class="sr" for="feature-email">Your email</label><input id="feature-email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" value="${esc(d.buyerEmail ?? '')}"><button class="btn${d.canEdit && d.credits ? ' ghost' : ''}">Pay $${esc(d.featureUsd)}</button></form><p class="muted small">You pick any coin or PayPal on CoinPay's checkout page. The receipt goes to your email.</p>` : ''}
</details>` : ''}` : ''}`,
  })
}

export function submitPage(ctx: Ctx, d: { values?: Record<string, string>; error?: { message: string; field?: string } } = {}): string {
  return layout({
    ctx,
    title: 'Launch your product · built.indie',
    description: 'Paste your URL; we fetch the rest. Free, no account.',
    path: '/submit',
    body: `<h1 class="page-h">Launch your product</h1>
<div class="card">${submitForm(false, d.values, d.error)}</div>
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Paste</h2><p class="muted">Your URL. We read the page like a browser, plus <code>/llms.txt</code>, <code>/.well-known/opensite.json</code> and your <code>openprofile.md</code>.</p></div>
  <div class="card"><h2><span class="step-n">2</span>Check</h2><p class="muted">Fix the name or tagline, drop a screenshot, add a video. Then publish.</p></div>
  <div class="card"><h2><span class="step-n">3</span>Share</h2><p class="muted">Today’s board resets at midnight UTC. Share your link, add the badge, collect upvotes.</p></div>
</div>`,
  })
}

export function editPage(ctx: Ctx, d: { product: Product; fresh?: boolean; flash?: string; error?: { message: string; field?: string } }): string {
  const p = d.product
  const pics = [p.logo, p.ogImage, p.screenshot, ...p.images].filter((f): f is string => Boolean(f))
  const label = (f: string) => (f === p.logo ? 'Logo' : f === p.ogImage ? 'Card image' : f === p.screenshot ? 'Homepage screenshot' : 'From your page')
  return layout({
    ctx,
    title: `Edit ${p.name} · built.indie`,
    description: 'Edit your launch.',
    path: `/p/${p.slug}/edit`,
    noindex: true,
    body: `${d.fresh ? `<p class="note">Here is what we read from ${esc(p.domain)}. Fix anything, then launch. It is in <a href="/me">your launches</a>${p.ownerId ? '' : `; <a href="/p/${esc(p.slug)}/claim">claim it</a> with your badge or a DNS record so it stays yours`}.</p>` : ''}
${d.flash ? `<p class="note">${esc(d.flash)}</p>` : ''}
${d.error ? `<p class="note error" role="alert">${esc(d.error.message)}</p>` : ''}
<h1 class="page-h">${p.status === 'draft' ? 'Check it, then launch' : `Edit ${esc(p.name)}`}</h1>
<p class="muted">We read <a href="${esc(p.url)}" rel="nofollow noopener">${esc(p.domain)}</a>${p.record ? ` · found: ${esc(((p.record as any).cards ? Object.keys((p.record as any).cards) : []).concat(p.llms ? ['llms.txt'] : [], p.profile ? ['openprofile.md'] : [], (p.record as any).source === 'declared' ? ['opensite.json'] : []).join(', ') || 'the page itself')}` : ''}.</p>
<form method="post" action="/p/${esc(p.slug)}/edit" class="card">
  <div class="product-head">${logoImg(p, 56)}<div class="product-title"><label for="name">Name</label><input id="name" name="name" maxlength="60" required value="${esc(p.name)}"></div></div>
  <label for="tagline">Tagline <span class="muted">(one line, 90 characters)</span></label><input id="tagline" name="tagline" maxlength="90" value="${esc(p.tagline)}">
  <label for="description">Description</label><textarea id="description" name="description" rows="5" maxlength="1200">${esc(p.description)}</textarea>
  <label for="tags">Tags <span class="muted">(comma separated, up to 6)</span></label><input id="tags" name="tags" value="${esc(p.tags.join(', '))}">
  <label for="videos">Videos <span class="muted">(YouTube, Vimeo, Loom or .mp4; one per line)</span></label><textarea id="videos" name="videos" rows="2">${esc(p.videos.map((v) => v.url).join('\n'))}</textarea>
  <label for="makerName">Made by</label><input id="makerName" name="makerName" maxlength="60" value="${esc(p.makerName)}">
  <label for="makerProfile">Maker’s OpenProfile.md <span class="muted">(<a href="https://logicsrc.com/openprofile">what is it?</a>)</span></label><input id="makerProfile" name="makerProfile" type="text" inputmode="url" value="${esc(p.makerProfile ?? '')}">
  ${pics.length ? `<fieldset class="pics"><legend>Pictures <span class="muted">(tick to remove)</span></legend>${pics.map((f) => `<label class="pic"><img src="${esc(mediaUrl(p, f)!)}" alt=""><span><input type="checkbox" name="remove" value="${esc(f)}"> ${esc(label(f))}</span></label>`).join('')}</fieldset>` : '<p class="muted">No pictures found on your page. Add an og:image or a screenshot to your homepage and re-read it.</p>'}
  <div class="row"><button class="btn ghost" name="action" value="save">Save</button>${p.status === 'draft' ? '<button class="btn" name="action" value="publish">Launch it 🚀</button>' : `<a class="btn ghost" href="/p/${esc(p.slug)}">View</a>`}</div>
</form>
<div class="row">
  <form method="post" action="/p/${esc(p.slug)}/edit" data-busy="Reading your homepage again…"><button class="chip" name="action" value="refetch">Re-read my homepage</button></form>
  <form method="post" action="/p/${esc(p.slug)}/edit" data-confirm="Delete ${esc(p.name)} for good?"><button class="chip danger" name="action" value="delete">Delete</button></form>
</div>`,
  })
}

/**
 * The claim as Markdown: a prompt to hand an AI agent (or a person) that has
 * access to the domain's DNS. Everything it needs is in it: the exact record,
 * where it goes, how to check it took, and how to finish the claim.
 */
export function claimMarkdown(origin: string, p: Product, record: { name: string; value: string }, badge: string): string {
  const bare = p.domain.replace(/^www\./, '')
  const label = record.name.slice(0, -(bare.length + 1))
  const id = badge.match(/images\.svg\?id=([A-Za-z0-9_-]+)/)?.[1] ?? ''
  return `# Claim ${p.name} on built.indie: the badge on the homepage, or one DNS TXT record

Prove control of \`${bare}\` so the listing ${origin}/p/${p.slug} can be claimed and edited. Either proof works; the badge is the easy one.

## Option A (easiest): the badge on the homepage

Put this HTML on the homepage, ${p.url}, and deploy it:

\`\`\`html
${badge}
\`\`\`

It shows the live built.indie badge, and its id (\`${id}\`) is unique to this listing and this built.indie account, so finding it on the homepage proves the site is yours. It also makes your link on built.indie a followed link and earns the ✓, in the same step. The badge must be served in the HTML of the homepage itself (not added later by JavaScript). Check with:

\`\`\`sh
curl -s ${p.url} | grep -o 'images.svg?id=[A-Za-z0-9_-]*'
# expect: images.svg?id=${id}
\`\`\`

Then finish the claim (below). Keep the badge up for the followed link.

## Option B: a DNS TXT record

| Field | Value |
| --- | --- |
| Type | \`TXT\` |
| Name / host | \`${record.name}\` (many DNS hosts want only \`${label}\`, relative to the zone) |
| Value / content | \`${record.value}\` |
| TTL | 300, or the host's default |

The same TXT value on \`${bare}\` itself also works, if a \`${label}\` name is not possible.

### Steps

1. Find the DNS zone that serves \`${bare}\`. It is the zone of the registered domain (for \`a.b.example.com\` that is usually \`example.com\`): check with \`dig +short NS ${bare}\`.
2. In that zone, add the TXT record above. Add it; do not replace or delete any existing TXT records (SPF, DKIM, other verifications).
3. Wait for it to be served, then check it from public resolvers (built.indie asks 1.1.1.1 and 9.9.9.9):

   \`\`\`sh
   dig +short TXT ${record.name} @1.1.1.1
   # expect: "${record.value}"
   \`\`\`

4. Finish the claim (below). The record can be removed once the claim succeeds.

A \`<meta name="built-indie-verify" content="${record.value}">\` tag (the bare \`${record.value}\` string anywhere in the homepage HTML) also counts.

## Finish the claim

Any one of:
   - open ${origin}/p/${p.slug}/claim (signed in as the same account) and press **Check**
   - \`BUILTINDIE_KEY=bi_… builtindie claim ${p.slug}\`
   - \`curl -X POST ${origin}/api/v1/products/${p.slug}/claim -H 'authorization: Bearer bi_…'\` (answers \`{"claimed": true}\`)

We check DNS, then the homepage. The badge id and the record are tied to one built.indie account: a badge or record made for another account will not claim it for this one.
`
}


export function claimPage(ctx: Ctx, d: { product: Product; record: { name: string; value: string }; badge: string; owner: boolean; result?: { ok: boolean; looked: string[]; method?: string } }): string {
  const p = d.product
  const md = claimMarkdown(ctx.origin, p, d.record, d.badge)
  const done = d.owner || d.result?.ok
  return layout({
    ctx,
    title: `Claim ${p.name} · built.indie`,
    description: `Prove you own ${p.domain} with the badge or a DNS record.`,
    path: `/p/${p.slug}/claim`,
    noindex: true,
    body: `<h1 class="page-h">${done ? `${esc(p.name)} is yours ✓` : `Claim ${esc(p.name)}`}</h1>
${done ? `<p class="note">You own this listing${d.result?.method === 'badge' ? ' (we found your badge)' : ''}. <a href="/p/${esc(p.slug)}/edit">Edit it</a>${d.result?.method === 'badge' ? '' : `, then add the <a href="/p/${esc(p.slug)}#badge">badge</a>`}.</p>` : `
${p.ownerId ? '<p class="note">Someone already claimed this listing. If you own the domain, adding your record below moves it to you.</p>' : ''}
${d.result && !d.result.ok ? `<p class="note error" role="alert">We did not find the badge or the record yet at ${d.result.looked.map((n) => `<code>${esc(n)}</code>`).join(' or ')}. DNS can take a few minutes; try again.</p>` : ''}
<p class="muted">Prove you control <b>${esc(p.domain)}</b>, either way: put your badge on the homepage (easiest), or add a TXT record at your DNS host. Then check.</p>
<div class="card" id="badge-claim">
  <h2 class="mini-h">1. The badge on your homepage (easiest)</h2>
  <p class="muted small">Put this badge on <b>${esc(p.url)}</b> and deploy. Its id is yours alone, so it proves the site is yours, and it also makes your link here a followed link and earns the ✓, in one step. It must be in the page’s HTML, not added by JavaScript.</p>
  <p><img src="/badge/${esc(p.slug)}.svg" alt="badge" width="200" height="44"></p>
  <pre><code>${esc(d.badge)}</code></pre>
  <div class="row"><button class="chip" data-copy="${esc(d.badge)}">Copy badge HTML</button></div>
</div>
<div class="card">
  <h2 class="mini-h">2. Or a DNS record</h2>
  <p class="small muted">Type</p><p><code>TXT</code></p>
  <p class="small muted">Name / host</p><div class="address"><code>${esc(d.record.name)}</code><button class="copy" data-copy="${esc(d.record.name.replace(`.${p.domain.replace(/^www\./, '')}`, ''))}">Copy</button></div>
  <p class="small muted">Some DNS hosts want only <code>_built-indie</code> here; others want the full name.</p>
  <p class="small muted">Value</p><div class="address"><code>${esc(d.record.value)}</code><button class="copy" data-copy="${esc(d.record.value)}">Copy</button></div>
  <p class="small muted">A TXT record on ${esc(p.domain.replace(/^www\./, ''))} itself with the same value works too. You can remove it once claimed.</p>
</div>
<form method="post" action="/p/${esc(p.slug)}/claim" data-busy="Checking your homepage and DNS…"><button class="btn">Check</button></form>
<div class="card">
  <h2 class="mini-h">${icon('terminal')} Have an AI do it</h2>
  <p class="muted small">Copy these instructions as Markdown and paste them to an agent (or a person) with access to your site or your DNS. They hold your badge and your record, how to check them, and how to finish the claim.</p>
  <div class="row"><button class="chip" data-copy="${esc(md)}">Copy as Markdown for AI</button><a class="chip" href="/p/${esc(p.slug)}/claim.md">Open as .md</a></div>
  <details><summary class="small">Preview</summary><pre><code>${esc(md)}</code></pre></details>
</div>`}`,
  })
}

/** The shared profile fields (@profullstack/profile) beside the form's own email box. */
const PROFILE_FIELDS = PROFILE_COLUMNS.filter((f) => f !== 'email')

export function loginPage(ctx: Ctx, d: { next: string | null; sent?: boolean; error?: string; email?: string; invitedBy?: string | null; signup?: boolean; values?: Record<string, string>; errors?: Record<string, string> }): string {
  const signup = Boolean(d.signup) && !d.sent
  return layout({
    ctx,
    title: signup ? 'Create your account · built.indie' : 'Sign in · built.indie',
    description: signup ? 'Create a built.indie account with a link by email.' : 'Sign in with a link by email.',
    path: signup ? '/signup' : '/login',
    noindex: true,
    body: `<section class="hero narrow"><h1>${d.sent ? 'Check your email' : signup ? 'Create your account' : 'Sign in'}</h1>
${d.sent ? '<p class="lede">If that address can receive mail, a sign-in link is on its way. It works once, for 20 minutes.</p>' : `<p class="lede">No password. We email you a link${signup ? '' : '; a new address makes an account'}. You need one only to claim and edit a listing. Launching is free and needs nothing.</p>
${d.invitedBy ? `<p class="note launched">${esc(d.invitedBy)} invited you. Sign up here, then launch your product: it is free, and it earns them a Featured week.</p>` : ''}
${d.error ? `<p class="note error" role="alert">${esc(d.error)}</p>` : ''}
<form method="post" action="/login" class="card">
  <input type="hidden" name="next" value="${esc(d.next ?? '')}">
  ${signup ? '<input type="hidden" name="mode" value="signup">' : ''}
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(d.email ?? '')}">
  ${signup ? renderProfileFields({ fields: PROFILE_FIELDS, values: d.values, errors: d.errors }) : ''}
  <p><button class="btn wide">${signup ? 'Create account' : 'Email me a link'}</button></p>
</form>
<p class="muted small">${signup ? `Already a member? <a href="/login${d.next ? `?next=${encodeURIComponent(d.next)}` : ''}">Sign in</a>` : `New here? <a href="/signup${d.next ? `?next=${encodeURIComponent(d.next)}` : ''}">Create an account</a>`}</p>
${signup ? '<script src="/vendor-profile.js" defer></script>' : ''}
${ctx.coinpay ? `<p class="or muted small">or</p>${coinpayButton(d.next)}<p class="muted small">One CoinPay account signs you in here and on the rest of the network.</p>` : ''}`}</section>`,
  })
}

function karmaCard(k: KarmaSummary, howToEarn: { action: string; points: number; rule: string }[], featureDays: number): string {
  const pct = Math.round(k.progress * 100)
  return `<div class="card" id="karma"><h2>${icon('trophy')} Karma <span class="karma-total">${k.total}</span></h2>
<p class="muted">${k.week >= 0 ? `+${k.week}` : k.week} this week · ${k.credits.granted} free Featured week${k.credits.granted === 1 ? '' : 's'} earned from karma${k.credits.used ? ` (${k.credits.used} used)` : ''} · <a href="/leaderboard">leaderboard</a></p>
<p><b>${k.nextCreditIn} karma</b> to your next free Featured week (${featureDays} days pinned on the homepage).</p>
<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${k.perCredit}" aria-valuenow="${k.perCredit - k.nextCreditIn}" aria-label="Progress to the next free Featured week"><span style="inline-size:${pct}%"></span></div>
${k.events.length ? `<h3 class="mini-h">History</h3><ol class="ledger">${k.events.map((e) => `<li><span class="pts${e.points < 0 ? ' neg' : ''}">${e.points > 0 ? '+' : ''}${e.points}</span> ${esc(e.label)} <time class="muted small" datetime="${new Date(e.at).toISOString()}">${when(e.at)}</time></li>`).join('')}</ol>` : '<p class="muted small">No karma yet. Here is how to earn it:</p>'}
<details${k.events.length ? '' : ' open'}><summary>How to earn karma</summary>${howToEarnTable(howToEarn)}<p class="muted small">Signed-in members only; acting on your own listing earns nothing. Every ${k.perCredit} karma grants one free Featured week, once.</p></details>
</div>`
}

export function mePage(ctx: Ctx, d: { user: User; products: Product[]; apiKey?: string; invite: InviteStats; karma?: KarmaSummary; howToEarn?: { action: string; points: number; rule: string }[]; featureDays?: number; coinpay?: { name: string | null } | null; emailless?: boolean; coinpayNote?: string | null; profile?: object | null; detailsNote?: string | null; detailsError?: boolean; detailsErrors?: Record<string, string> }): string {
  return layout({
    ctx,
    title: 'Your launches · built.indie',
    description: 'Your launches.',
    path: '/me',
    noindex: true,
    body: `<h1 class="page-h">Your launches</h1>
${d.coinpayNote ? `<p class="note">${esc(d.coinpayNote)}</p>` : ''}
<p class="muted">Signed in ${d.emailless ? `with CoinPay${d.coinpay?.name ? ` as ${esc(d.coinpay.name)}` : ''}` : `as ${esc(d.user.email)}`}. <form class="inline" method="post" action="/logout"><button class="linkish">Sign out</button></form></p>
${d.products.length ? `<ol class="board">${d.products.map((p) => `<li class="row-item"><a class="row-main" href="/p/${esc(p.slug)}">${logoImg(p)}<span class="row-text"><b>${esc(p.name)}</b><span class="muted">${p.status === 'draft' ? 'draft' : `▲ ${p.votes}`} · ${p.ownerId === d.user.id ? 'claimed ✓' : 'submitted by you, not claimed'}</span></span></a><a class="chip" href="/p/${esc(p.slug)}/edit">Edit</a>${p.ownerId === d.user.id ? '' : `<a class="chip" href="/p/${esc(p.slug)}/claim">Claim</a>`}</li>`).join('')}</ol>` : '<p class="empty">Nothing yet. <a href="/submit">Launch something</a>, or open a listing that is yours and claim it.</p>'}
${d.karma ? karmaCard(d.karma, d.howToEarn ?? [], d.featureDays ?? 7) : ''}
<div class="card"><h2>${icon('star')} Invites</h2><p class="muted">${d.invite.invited} joined through your link · ${d.invite.launched} launched · <b>${d.invite.credits}</b> free Featured week${d.invite.credits === 1 ? '' : 's'} to use${d.invite.karmaCredits ? ` (${d.invite.karmaCredits} from karma)` : ''}.</p><p><a class="chip" href="/invite">Your invite link and credits</a></p></div>
${ctx.coinpay || d.coinpay ? `<div class="card" id="signin"><h2>Sign in with CoinPay</h2>${d.coinpay ? `<p class="muted">Connected${d.coinpay.name ? ` (${esc(d.coinpay.name)})` : ''}: your CoinPay account signs you in here.</p>` : `<p class="muted">Connect your CoinPay account to sign in with it, here and across the network. We link the account itself, never by email.</p>${coinpayButton('/me', 'Connect CoinPay')}`}</div>` : ''}
<div class="card" id="details"><h2>Your details</h2><p class="muted small">Private to your account, never shown on a public page.</p>
${d.detailsNote ? `<p class="note${d.detailsError ? ' error' : ''}" role="status">${esc(d.detailsNote)}</p>` : ''}
<form method="post" action="/me/profile">${renderProfileFields({ fields: PROFILE_FIELDS, values: (d.profile ?? {}) as Record<string, string | null>, errors: d.detailsErrors, idPrefix: 'details-' })}<p><button class="chip">Save details</button></p></form></div>
<div class="card" id="api"><h2>API key</h2>
${d.apiKey ? `<p class="note"><b>Copy it now</b>, we show it once. Making a new one retires this one.</p><div class="address"><code>${esc(d.apiKey)}</code><button class="copy" data-copy="${esc(d.apiKey)}">Copy</button></div><pre>export BUILTINDIE_KEY=${esc(d.apiKey)}</pre>` : '<p class="muted">For the CLI, the TUI and the MCP server: edit and claim from the terminal or an agent.</p>'}
<form method="post" action="/me/key"><button class="chip">${d.apiKey ? 'Make another' : 'Make an API key'}</button></form></div>`,
  })
}

export function makerPage(ctx: Ctx, d: { maker: Maker; products: Product[] }): string {
  const m = d.maker
  return layout({
    ctx,
    title: `${m.name} · built.indie`,
    description: m.headline || `What ${m.name} launched on built.indie`,
    path: `/makers/${m.id}`,
    ads: true,
    head: `<link rel="alternate" type="text/markdown" title="OpenProfile" href="/makers/${esc(m.id)}/openprofile.md">`,
    body: `<section class="payee"><h1>${esc(m.name)}</h1><p class="lede">${esc(m.headline)}</p>
<p class="socials">${[m.profileUrl, ...m.accounts].slice(0, 8).map((a) => `<a class="chip" href="${esc(a)}" rel="nofollow noopener me">${esc(a.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40))}</a>`).join('')}</p></section>
<h2 class="section-h">Launched</h2>${board(ctx, d.products, false) || '<p class="empty">Nothing live yet.</p>'}
<p class="muted small"><a href="/makers/${esc(m.id)}/openprofile.md">OpenProfile.md</a></p>`,
  })
}

export function helpPage(ctx: Ctx): string {
  const o = ctx.origin
  return layout({
    ctx,
    title: 'API, CLI and MCP · built.indie',
    description: 'Launch, read and upvote from code: a JSON API, a CLI, a TUI and an MCP server.',
    path: '/help',
    body: `<h1 class="page-h">Launch from anywhere</h1>
<p class="muted">Everything on the site is an API. Launching and reading need nothing. To edit, sign in (an email link, or Sign in with CoinPay), claim your product by putting your badge on its homepage (or with a DNS record), and make an API key on <a href="/me">your page</a>.</p>
<div class="card"><h2>API</h2>
<pre>curl -X POST ${o}/api/v1/products -H 'content-type: application/json' \\
  -d '{"url":"yourproduct.com","maker_name":"You"}'
# → { product, claim_url }   free; live at once

curl ${o}/api/v1/products?window=today      # today|week|month|all|new|featured
curl ${o}/api/v1/products?tag=game          # one tag
curl ${o}/api/v1/tags                       # every tag with its count
curl '${o}/api/v1/search?q=crm&amp;category=ai&amp;tag=productivity&amp;has=verified&amp;sort=new'   # + facets with counts
curl ${o}/api/v1/categories                 # every category and tag, with counts
curl ${o}/api/v1/products/&lt;slug&gt;
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/vote
curl -X POST ${o}/api/v1/preview -d '{"url":"any.site"}' -H 'content-type: application/json'
curl ${o}/api/v1/products/&lt;slug&gt;/claim -H 'authorization: Bearer bi_…'   # your badge (with your badge id), or the TXT record
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/claim -H 'authorization: Bearer bi_…'   # check for the badge on your homepage, or DNS
curl -X PATCH ${o}/api/v1/products/&lt;slug&gt; -H 'authorization: Bearer bi_…' \\
  -H 'content-type: application/json' -d '{"tagline":"…","videos":["https://youtu.be/…"]}'
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/refetch -H 'authorization: Bearer bi_…'
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/publish -H 'authorization: Bearer bi_…'
curl ${o}/api/v1/invites -H 'authorization: Bearer bi_…'                 # your invite link and credits
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/credit -H 'authorization: Bearer bi_…'   # spend one: Featured for a week
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/feature -H 'authorization: Bearer bi_…' -d '{"email":"you@…"}'   # pay: a CoinPay checkout_url (any coin or PayPal)
curl ${o}/leaderboard/invites.json?period=week                       # top inviters (all|week|month)
curl '${o}/api/v1/leaderboard?board=karma&amp;period=week'             # top karma (board karma|invites)
curl ${o}/api/v1/karma -H 'authorization: Bearer bi_…'                   # your karma, history, next free Featured week
curl ${o}/api/v1/products/&lt;slug&gt;/comments
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/comments -H 'authorization: Bearer bi_…' -d '{"body":"…","parent":"&lt;comment id, optional&gt;"}'
curl -X DELETE ${o}/api/v1/comments/&lt;id&gt; -H 'authorization: Bearer bi_…'     # your own (the points go back)
curl ${o}/api/v1/products/&lt;slug&gt;/reviews
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/reviews -H 'authorization: Bearer bi_…' -d '{"rating":5,"body":"…"}'
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/share -H 'authorization: Bearer bi_…' -d '{"network":"bluesky"}'   # x|bluesky|linkedin|reddit|hn|mastodon|copy</pre>
<p class="muted small">Claiming, the easy way: the badge. <code>GET …/claim</code> answers a <code>badge</code> snippet next to the DNS <code>record</code>; put it on your homepage (<code>&lt;img src="${o}/images.svg?id=&lt;id&gt;"&gt;</code>, the id is yours for that listing) and the <code>POST</code> answers <code>{"claimed": true, "method": "badge"}</code>. It also earns the followed link and the ✓ in the same step.</p>
<p class="muted small">OpenSite (logicsrc.com/docs/opensite): <code>GET /api/v1/sites?url=…</code>, <code>POST /api/v1/sites</code>, and every product at <code>/p/&lt;slug&gt;/opensite.json</code>. OpenProfile: <code>/p/&lt;slug&gt;/openprofile.md</code>, <code>/makers/&lt;id&gt;/openprofile.md</code>.</p></div>
<div class="card" id="cli"><h2>CLI and TUI</h2>
<pre>curl -fsSL ${o}/install.sh | sh                # installs builtindie
builtindie                                    # TUI: today's board, vote, launch
bunx @profullstack/builtindie                 # or run it without installing
bunx @profullstack/builtindie launch yourproduct.com
bunx @profullstack/builtindie top week
bunx @profullstack/builtindie search crm --category ai --has verified --facets
bunx @profullstack/builtindie show &lt;slug&gt;
bunx @profullstack/builtindie vote &lt;slug&gt;
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie claim &lt;slug&gt;   # your badge (or a TXT record), then checks it
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie invite          # your invite link and free Featured credits
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie karma           # your karma and history
bunx @profullstack/builtindie leaderboard [karma|invites] [--period week|month|all]
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie comment &lt;slug&gt; "text" [--reply &lt;id&gt;]
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie review &lt;slug&gt; 5 "text"
bunx @profullstack/builtindie comments &lt;slug&gt; · reviews &lt;slug&gt;
bunx @profullstack/builtindie preview any.site --json</pre></div>
<div class="card" id="mcp"><h2>MCP</h2>
<pre>claude mcp add builtindie -- bunx @profullstack/builtindie mcp</pre>
<p class="muted">Tools: <code>launch_product</code>, <code>preview_site</code>, <code>list_products</code>, <code>get_product</code>, <code>upvote</code>, <code>search</code> (with filters and facets), <code>list_categories</code>, and with <code>BUILTINDIE_KEY</code>: <code>claim_product</code>, <code>edit_product</code>, <code>my_products</code>, <code>my_invites</code>, <code>feature_with_credit</code>, <code>my_karma</code>, <code>comment</code>, <code>review</code>; without a key: <code>leaderboard</code>, <code>list_comments</code>, <code>list_reviews</code>.</p></div>
<div class="card" id="karma"><h2>Karma</h2><p class="muted">Signed-in members earn karma; anonymous actions still work and earn nothing. Acting on your own listing earns nothing. Every 500 karma grants one free Featured week. The same rules run on pwamart.com.</p>
<table class="earn"><thead><tr><th scope="col">Do this</th><th scope="col">Karma</th></tr></thead><tbody><tr><td>Launch a listing</td><td class="pts">+10</td></tr><tr><td>Upvote (20 paid a day)</td><td class="pts">+1</td></tr><tr><td>Review: stars and 30+ characters</td><td class="pts">+5</td></tr><tr><td>Comment: 10+ characters (10 paid a day; deleting takes it back)</td><td class="pts">+2</td></tr><tr><td>Share button (once per listing, network and day; 5 a day)</td><td class="pts">+1</td></tr><tr><td>Your launch gets an upvote from a member</td><td class="pts">+1</td></tr><tr><td>Your launch gets a review</td><td class="pts">+2</td></tr><tr><td>Claim your listing</td><td class="pts">+5</td></tr><tr><td>An invited maker launches</td><td class="pts">+25</td></tr><tr><td>Badge verified on your homepage</td><td class="pts">+5</td></tr></tbody></table></div>
<div class="card" id="bot"><h2>Our reader</h2>
<p class="muted">We fetch only what a person submits, once, plus a re-read when the maker asks. User agent <code>built.indie/1.0</code>. We honour <code>robots.txt</code> and <code>index.allow: false</code> in <code>/.well-known/opensite.json</code>. Screenshots are taken with headless Chrome.</p></div>
<div class="card"><h2>Make your page read well</h2>
<ul class="muted"><li><code>og:image</code> 1200×630 and an <code>apple-touch-icon</code> or a manifest icon 512×512</li><li><code>/llms.txt</code>: <code># Name</code>, then <code>&gt; one-line summary</code></li><li><code>/.well-known/opensite.json</code> (<a href="https://logicsrc.com/opensite">OpenSite</a>) to say it yourself</li><li><code>/.well-known/openprofile.md</code> (<a href="https://logicsrc.com/openprofile">OpenProfile</a>) with <code>Kind: organization</code> and your accounts</li><li><code>/.well-known/openstack.md</code> (<a href="https://logicsrc.com/docs/openstack">OpenStack.md</a>): we show it as “Built with”</li><li><code>/.well-known/opensaas.json</code> (<a href="https://logicsrc.com/opensaas">OpenSaaS</a>): your plans and your cancel page</li><li><code>/.well-known/openicon.json</code> (<a href="https://logicsrc.com/docs/openicon">OpenIcon</a>) if you publish an icon set</li><li>a YouTube/Vimeo/Loom embed or <code>og:video</code> for your demo</li></ul></div>`,
  })
}

/** Your invite link, what it has earned, and the listings a credit can feature. */
export function invitePage(ctx: Ctx, d: { featureDays: number; featureUsd: number; inviters: InviterRow[]; me?: { link: string; stats: InviteStats; name: string; displayName: string | null; listings: Product[]; flash?: string; error?: string } }): string {
  const m = d.me
  const text = 'I launch my indie products on built.indie: one URL and it pulls in the logo, screenshots and story. Launch yours free:'
  const shares: [string, string, string][] = m
    ? [
        ['X', 'x', `https://x.com/intent/post?text=${enc(text)}&url=${enc(m.link)}`],
        ['Bluesky', 'bluesky', `https://bsky.app/intent/compose?text=${enc(`${text} ${m.link}`)}`],
        ['LinkedIn', 'linkedin', `https://www.linkedin.com/sharing/share-offsite/?url=${enc(m.link)}`],
        ['Email', 'mail', `mailto:?subject=${enc('Launch your product on built.indie')}&body=${enc(`${text}\n\n${m.link}`)}`],
      ]
    : []
  const featuring = (p: Product) => (p.featuredUntil && p.featuredUntil > Date.now() ? `Featured until ${new Date(p.featuredUntil).toISOString().slice(0, 10)}` : p.domain)
  return layout({
    ctx,
    title: 'Invite makers, get Featured free · built.indie',
    description: inviteOffer(d.featureDays, d.featureUsd),
    path: '/invite',
    ads: !m,
    body: `<section class="hero"><h1>Invite a maker.<br>Get Featured free.</h1>
<p class="lede">${esc(inviteOffer(d.featureDays, d.featureUsd))}</p></section>
${m?.flash ? `<p class="note launched">${esc(m.flash)}</p>` : ''}${m?.error ? `<p class="note error" role="alert">${esc(m.error)}</p>` : ''}
${
  m
    ? `<div class="card"><h2>Your invite link</h2>
<div class="address"><code>${esc(m.link)}</code><button class="copy" data-copy="${esc(m.link)}">Copy</button></div>
<div class="share">${shares.map(([n, i, h]) => `<a class="chip" href="${esc(h)}" target="_blank" rel="noopener">${icon(i)} ${esc(n)}</a>`).join('')}</div>
<div class="grid3 stats"><div><b>${m.stats.invited}</b><span class="muted small">joined</span></div><div><b>${m.stats.launched}</b><span class="muted small">launched</span></div><div><b>${m.stats.credits}</b><span class="muted small">free weeks to use</span></div></div>
</div>
${
  m.stats.credits
    ? `<div class="card"><h2>${icon('star')} Use a credit</h2>${
        m.listings.length
          ? `<ol class="board">${m.listings.map((p) => `<li class="row-item"><a class="row-main" href="/p/${esc(p.slug)}">${logoImg(p, 36)}<span class="row-text"><b>${esc(p.name)}</b><span class="muted">${esc(featuring(p))}</span></span></a><form method="post" action="/p/${esc(p.slug)}/credit"><button class="chip">Feature ${d.featureDays} days</button></form></li>`).join('')}</ol>`
          : '<p class="muted">You have no live listing yet. <a href="/submit">Launch one</a>, then come back to feature it.</p>'
      }</div>`
    : ''
}
<div class="card"><h2>Your name on the board</h2><p class="muted small">Shown as <b>${esc(m.name)}</b>. We never show your email.</p>
<form method="post" action="/invite/name" class="row"><label class="sr" for="displayName">Display name</label><input id="displayName" name="displayName" maxlength="40" placeholder="Your name or handle" value="${esc(m.displayName ?? '')}"><button class="chip">Save</button></form></div>`
    : '<p class="center"><a class="btn" href="/login?next=/invite">Sign in to get your invite link</a></p>'
}
<div class="grid3">
  <div class="card"><h2><span class="step-n">1</span>Share</h2><p class="muted">Send your link to a maker who has shipped something.</p></div>
  <div class="card"><h2><span class="step-n">2</span>They launch</h2><p class="muted">They sign up through it and publish a listing. One URL; we fetch the rest.</p></div>
  <div class="card"><h2><span class="step-n">3</span>You are Featured</h2><p class="muted">You get a credit: ${d.featureDays} days pinned on the homepage, on any listing you own.</p></div>
</div>
<h2 class="section-h">Top inviters this week <a class="small" href="/leaderboard">full board</a></h2>
${d.inviters.length ? invitersList(d.inviters) : '<p class="empty">Nobody yet. One invite that launches puts you at #1.</p>'}
<p class="muted small">It counts once per new member, the first time a listing they submitted goes live. Inviting yourself does not count.</p>`,
  })
}

/** Where an invite link lands: who invited you, and one step to launch. */
export function inviteLanding(ctx: Ctx, d: { inviter: string }): string {
  return layout({
    ctx,
    title: `${d.inviter} invited you to launch on built.indie`,
    description: 'Launch your indie product with one URL. We fetch the logo, screenshots and story; people upvote; you get a badge. Free.',
    path: '/invite',
    noindex: true,
    body: `<section class="hero"><h1>${esc(d.inviter)} invited you.</h1>
<p class="lede">Launch your indie product with one URL. We pull your logo, screenshots, videos and story from your homepage. People upvote. You get a badge. Free.</p>
${
  ctx.user
    ? `<p><a class="btn" href="/submit">${icon('rocket')} Launch your product</a></p>`
    : `<p><a class="btn" href="/login?next=/submit">${icon('rocket')} Sign up and launch</a></p><p class="muted small">Sign up with your email first, then launch: that is what earns ${esc(d.inviter)} a free Featured week, and you get your own invite link too.</p>`
}
</section>`,
  })
}

/** The boards in the site's layout: karma (default) and inviters; the widget is @profullstack/leaderboard's. */
export function leaderboardPage(ctx: Ctx, d: { board: 'karma' | 'invites'; period: 'week' | 'all'; featureDays: number; featureUsd: number; perCredit: number; howToEarn: { action: string; points: number; rule: string }[]; me?: string | null }): string {
  const karma = d.board === 'karma'
  const title = karma ? 'Top karma' : 'Top inviters'
  const tabs = `<nav class="tabs" aria-label="Boards"><a href="/leaderboard"${karma ? ' aria-current="page"' : ''}>Karma</a><a href="/leaderboard?board=invites"${karma ? '' : ' aria-current="page"'}>Inviters</a></nav>`
  const intro = karma ? `Members earn karma for launching, upvoting, reviewing, commenting and sharing. Every ${d.perCredit} karma is a free Featured week (${d.featureDays} days pinned on the homepage, a $${d.featureUsd} spot).` : inviteOffer(d.featureDays, d.featureUsd)
  return layout({
    ctx,
    title: `${title} · built.indie`,
    description: karma ? `The most helpful members of built.indie. ${intro}` : `The members who brought the most makers to built.indie. ${intro}`,
    path: karma ? '/leaderboard' : '/leaderboard?board=invites',
    ads: true,
    head: `<link rel="alternate" type="application/rss+xml" title="${title}" href="/leaderboard/${d.board}.xml?period=week">`,
    body: `<h1 class="page-h">${icon('trophy')} ${title}</h1>
${tabs}
<p class="muted">${esc(intro)} ${karma ? `<a href="${ctx.user ? '/me#karma' : '/login?next=/me'}">${ctx.user ? 'Your karma' : 'Sign in to earn'}</a>` : '<a href="/invite">Get your link</a>'}</p>
${d.period === 'all' ? '<p class="muted small">Nobody has scored this week yet, so this opens on all time. Be the first this week.</p>' : ''}
<div class="card"><div data-leaderboard></div><script src="/leaderboard/embed.js" data-board="${d.board}" data-period="${d.period}" data-limit="25"${d.me ? ` data-me="${esc(d.me)}"` : ''}></script></div>
${karma ? `<div class="card"><h2 class="mini-h">How to earn karma</h2>${howToEarnTable(d.howToEarn)}<p class="muted small">Signed-in members only; anonymous upvotes still count on the board but earn nothing. Acting on your own listing earns nothing.</p><p><a class="btn small-btn" href="/top/today">Upvote today’s launches</a></p></div>` : ''}
<p class="muted small">Put this board on your site: <code>&lt;div data-leaderboard&gt;&lt;/div&gt;&lt;script src="${esc(ctx.origin)}/leaderboard/embed.js" data-board="${d.board}"&gt;&lt;/script&gt;</code> · <a href="/api/v1/leaderboard?board=${d.board}&amp;period=week">JSON</a> · <a href="/leaderboard/${d.board}.xml?period=week">RSS</a></p>`,
  })
}

export function messagePage(ctx: Ctx, d: { title: string; message: string; status?: number }): string {
  return layout({ ctx, title: `${d.title} · built.indie`, description: d.message, path: '/', noindex: true, body: `<section class="hero"><h1>${esc(d.title)}</h1><p class="lede">${esc(d.message)}</p><a class="btn" href="/">Home</a></section>` })
}

/** The embeddable badge: live upvotes, or the day's award once it is won. */
/** The badge for a site with no listing (the shared footer asks for every site): an invitation to launch. */
export function launchBadgeSvg(theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="44" viewBox="0 0 200 44" role="img" aria-label="Launch yours on built.indie">
<rect x=".5" y=".5" width="199" height="43" rx="9" fill="${dark ? '#111018' : '#ffffff'}" stroke="#ff5c39"/>
<path d="M22 9 12 21h6v12h8V21h6z" fill="#ff5c39"/>
<text x="42" y="18" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="8.5" font-weight="700" letter-spacing=".6" fill="${dark ? '#a7a1bd' : '#5d5870'}">LAUNCH YOURS FREE ON</text>
<text x="42" y="33" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="15" font-weight="800" fill="${dark ? '#f4f1ff' : '#14121c'}">built.indie</text>
</svg>`
}

export function badgeSvg(p: Product, award: { day: string; rank: number } | null, theme: 'dark' | 'light'): string {
  const dark = theme === 'dark'
  const bg = dark ? '#111018' : '#ffffff'
  const fg = dark ? '#f4f1ff' : '#14121c'
  const sub = dark ? '#a7a1bd' : '#5d5870'
  const accent = '#ff5c39'
  const top = award ? `#${award.rank} PRODUCT OF THE DAY` : 'LAUNCHED ON'
  const count = String(p.votes)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="44" viewBox="0 0 200 44" role="img" aria-label="${esc(p.name)}: ${esc(top.toLowerCase())} built.indie, ${count} upvotes">
<rect x=".5" y=".5" width="199" height="43" rx="9" fill="${bg}" stroke="${accent}"/>
<path d="M22 9 12 21h6v12h8V21h6z" fill="${accent}"/>
<text x="42" y="18" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="8.5" font-weight="700" letter-spacing=".6" fill="${sub}">${esc(top)}</text>
<text x="42" y="33" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="15" font-weight="800" fill="${fg}">built.indie</text>
<line x1="150" y1="9" x2="150" y2="35" stroke="${dark ? '#2a2736' : '#e6e3ee'}"/>
<text x="175" y="20" text-anchor="middle" font-family="system-ui,sans-serif" font-size="10" fill="${accent}">▲</text>
<text x="175" y="34" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="13" font-weight="800" fill="${fg}">${esc(count)}</text>
</svg>`
}
