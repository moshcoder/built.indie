/**
 * Server-rendered pages. One small script (public/app.js) votes without a page
 * load, copies snippets, shows progress while we read a site, and registers the
 * service worker; everything works without it.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Maker, Product, User, Window } from './db.js'
import { RING_PLACEHOLDER } from './ring.js'
import { CHAIN_LABELS } from './service.js'
import { icon, SOCIAL_ICONS } from './icons.js'

export const REPO = 'https://github.com/moshcoder/built.indie'

/** crawlproof analytics on every page (project 71b194a4…); CRAWLPROOF_SITE=off turns it off. */
const TRACK_SITE = process.env.CRAWLPROOF_SITE ?? '71b194a4-9ae7-4b79-9ec1-0cf0d5ef203e'
const TRACKER = TRACK_SITE === 'off' ? '' : `<script data-site="${TRACK_SITE}" src="https://crawlproof.com/stats.js" async></script>`

/**
 * A crawlproof ad: a cross-origin, sandboxed iframe, so it can never read the
 * page. Only on pages where nobody is typing: never on submit or edit.
 * CRAWLPROOF_AD_SLOT overrides the slot; 'off' turns ads off.
 */
export const AD_SLOT = process.env.CRAWLPROOF_AD_SLOT ?? '7371269e-a3c9-4a84-8b22-00d5045068e7'
export const adUnit = (format: 'banner_300x250' | 'banner_728x90' | 'text_link') =>
  AD_SLOT === 'off' ? '' : `<div class="ad-unit ad-${format}"><iframe src="https://crawlproof.com/api/ads/frame?slot=${encodeURIComponent(AD_SLOT)}&amp;format=${format}" title="Advertisement" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" scrolling="no"></iframe></div>`

const asset = (name: string) => {
  const body = readFileSync(new URL(`../public/${name}`, import.meta.url))
  return `/${name}?v=${createHash('sha256').update(body).digest('hex').slice(0, 10)}`
}
const STYLE_URL = asset('style.css')
const SCRIPT_URL = asset('app.js')

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!)
const enc = encodeURIComponent

const LOGO = `<svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 5 17h7v11h8V17h7z" fill="currentColor"/></svg>`

export type Ctx = { origin: string; user?: User | null; voted?: (id: string) => boolean }

type LayoutOptions = { title: string; description: string; path: string; body: string; ctx: Ctx; noindex?: boolean; image?: string | null; head?: string; ads?: boolean }

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
<header class="top">
  <a class="brand" href="/">${LOGO}<span>built<b>.</b>indie</span></a>
  <nav aria-label="Site">
    <a href="/top/today">Today</a>
    <a href="/top/week">Week</a>
    <a href="/new">New</a>
    <a href="/help">API</a>
    ${o.ctx.user ? '<a href="/me">Mine</a>' : '<a href="/login">Sign in</a>'}
    <a class="btn small-btn" href="/submit">${icon('rocket')} Launch</a>
  </nav>
</header>
<main>
${o.body}
</main>
${o.ads ? adUnit('text_link') : ''}
<footer>
  <span>built.indie: launch your indie product with one URL. Free, open source.</span>
  <span><a href="/help">API · CLI · MCP</a> · <a href="/feed.xml">RSS</a> · <a href="${REPO}">Source</a> · <a href="https://pit.world/ring">Moshpit ring</a></span>
</footer>
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
    ${p.tags.length ? `<span class="tags">${p.tags.slice(0, 3).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</span>` : ''}</span>
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
  <p class="muted small">Free. We read the homepage: name, tagline, logo, screenshots, videos, socials, <code>llms.txt</code>, and the <a href="https://logicsrc.com/specs">LogicSRC</a> files: <code>opensite.json</code>, <code>openprofile.md</code>, <code>openstack.md</code>, <code>opensaas.json</code>, <code>openicon.json</code>. Anyone can launch any site; the owner claims it with a DNS record.</p>
</form>`
}

export function homePage(ctx: Ctx, d: { today: Product[]; featured: Product[]; yesterday: Product[]; stats: { products: number; votes: number } }): string {
  return layout({
    ctx,
    title: 'built.indie: launch your indie product with one URL',
    description: 'Paste a URL. We fetch everything: logo, screenshots, videos, llms.txt. Get upvotes and a badge. Free.',
    path: '/',
    ads: true,
    body: `<section class="hero">
  <h1>Built it? Launch it.</h1>
  <p class="lede">Paste one URL. We pull your logo, screenshots, videos and story from your homepage. People upvote. You get a badge.</p>
  ${submitForm(true)}
  <p class="muted small">${d.stats.products} launched · ${d.stats.votes} upvotes · free, no sign-up to launch</p>
</section>
${d.featured.length ? `<h2 class="section-h">Featured</h2>${board(ctx, d.featured, false)}` : ''}
<h2 class="section-h">Launching today <span class="muted small">resets at 00:00 UTC</span></h2>
${board(ctx, d.today) || `<p class="empty">Nothing launched yet today. <a href="/submit">Be first</a>: first launch of the day gets the top spot until someone beats it.</p>`}
${d.yesterday.length ? `<h2 class="section-h">Yesterday’s winners</h2>${board(ctx, d.yesterday.slice(0, 3))}` : ''}
<p class="center"><a href="/top/week">This week</a> · <a href="/top/month">This month</a> · <a href="/top/all">All time</a> · <a href="/new">Newest</a></p>
${adUnit('banner_728x90')}`,
  })
}

const WINDOW_TITLES: Record<Window, string> = { today: 'Top today', week: 'Top this week', month: 'Top this month', all: 'Top of all time', new: 'Newest launches', featured: 'Featured' }

export function boardPage(ctx: Ctx, window: Window, products: Product[], q?: string): string {
  const tabs = (['today', 'week', 'month', 'all', 'new'] as Window[]).map((w) => `<a href="${w === 'new' ? '/new' : `/top/${w}`}"${w === window && !q ? ' aria-current="page"' : ''}>${esc(WINDOW_TITLES[w].replace(/^Top (this )?|^Top of /, '').replace(/^Newest launches$/, 'New'))}</a>`).join('')
  return layout({
    ctx,
    title: q ? `“${q}” on built.indie` : `${WINDOW_TITLES[window]} · built.indie`,
    description: `${WINDOW_TITLES[window]}: indie products launched on built.indie.`,
    path: q ? `/search?q=${enc(q)}` : window === 'new' ? '/new' : `/top/${window}`,
    noindex: Boolean(q),
    ads: true,
    body: `<h1 class="page-h">${q ? `Search: ${esc(q)}` : esc(WINDOW_TITLES[window])}</h1>
<nav class="tabs" aria-label="Boards">${tabs}</nav>
<form class="search" method="get" action="/search"><label class="sr" for="q">Search</label><input id="q" name="q" placeholder="Search launches" value="${esc(q ?? '')}"></form>
${board(ctx, products, window !== 'new') || '<p class="empty">Nothing here yet.</p>'}
${adUnit('banner_300x250')}`,
  })
}

function share(origin: string, p: Product): string {
  const url = `${origin}/p/${p.slug}`
  const text = `${p.name}: ${p.tagline || p.domain}. Launched on built.indie, upvote it 👇`
  const links: [string, string][] = [
    ['X', `https://x.com/intent/post?text=${enc(text)}&url=${enc(url)}`],
    ['Bluesky', `https://bsky.app/intent/compose?text=${enc(`${text} ${url}`)}`],
    ['LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`],
    ['Reddit', `https://www.reddit.com/submit?url=${enc(url)}&title=${enc(`${p.name}: ${p.tagline}`)}`],
    ['Hacker News', `https://news.ycombinator.com/submitlink?u=${enc(p.url)}&t=${enc(`Show HN: ${p.name} – ${p.tagline}`)}`],
  ]
  const icons: Record<string, string> = { X: 'x', Bluesky: 'bluesky', LinkedIn: 'linkedin', Reddit: 'reddit', 'Hacker News': 'code' }
  return `<div class="share">${links.map(([n, h]) => `<a class="chip" href="${esc(h)}" target="_blank" rel="noopener">${icon(icons[n] ?? 'share')} ${esc(n)}</a>`).join('')}<button class="chip" data-copy="${esc(url)}">${icon('link')} Copy link</button></div>`
}

export function badgeSnippet(origin: string, p: Product): string {
  return `<a href="${origin}/p/${p.slug}?ref=badge"><img src="${origin}/badge/${p.slug}.svg" alt="${p.name} on built.indie" width="200" height="44"></a>`
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

export function productPage(ctx: Ctx, d: { product: Product; award: { day: string; rank: number } | null; maker: Maker | null; featuredOk?: boolean; launched?: boolean; canEdit?: boolean; chains: string[]; featureUsd: number; featureDays: number; payments: boolean }): string {
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
    head: `<link rel="opensite" href="/p/${esc(p.slug)}/opensite.json"><link rel="alternate" type="text/markdown" title="OpenProfile" href="/p/${esc(p.slug)}/openprofile.md">`,
    body: `${d.launched && live ? `<div class="note launched"><b>🚀 ${esc(p.name)} is live.</b> Today’s board resets at midnight UTC: share it now. ${p.ownerId ? '' : `Is it yours? <a href="/p/${esc(p.slug)}/claim">Claim it</a> with a DNS record to edit it and get the ✓.`}</div>` : ''}
${d.featuredOk ? '<p class="note">Thanks! Your payment is on its way; the Featured spot starts the moment CoinPay confirms it.</p>' : ''}
${!live ? `<p class="note">${p.status === 'draft' ? 'Draft: only people with the edit link see this.' : 'Taken down.'}</p>` : ''}
<section class="product-head">
  ${logoImg(p, 72)}
  <div class="product-title">
    <h1>${esc(p.name)}</h1>
    <p class="lede">${esc(p.tagline)}</p>
    <p class="badges">${awardText ? `<span class="pill gold">🏆 ${esc(awardText)}</span>` : ''}${p.featuredUntil && p.featuredUntil > Date.now() ? '<span class="pill">★ Featured</span>' : ''}${p.verifiedAt ? '<span class="pill ok" title="Their homepage links back to built.indie">✓ Verified</span>' : ''}${p.llms ? `<a class="pill" href="${esc(p.llms.url)}" rel="nofollow noopener">llms.txt</a>` : ''}${p.profile ? `<a class="pill" href="${esc(p.profile.url)}" rel="nofollow noopener">OpenProfile</a>` : ''}${p.record?.source === 'declared' ? '<span class="pill">OpenSite</span>' : ''}${p.extras.stack ? `<a class="pill" href="${esc(p.extras.stack.url)}" rel="nofollow noopener">OpenStack</a>` : ''}${p.extras.pricing ? `<a class="pill" href="${esc(p.extras.pricing.url)}" rel="nofollow noopener">OpenSaaS</a>` : ''}${p.extras.openicon ? `<a class="pill" href="${esc(p.extras.openicon)}" rel="nofollow noopener">OpenIcon</a>` : ''}</p>
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
  ${p.tags.length ? `<p class="tags">${p.tags.map((t) => `<a class="tag" href="/search?q=${enc(t)}">${esc(t)}</a>`).join('')}</p>` : ''}
  ${Object.keys(p.socials).length ? `<p class="socials">${Object.entries(p.socials).map(([k, v]) => `<a class="chip" href="${esc(v)}" rel="nofollow noopener" target="_blank">${icon(SOCIAL_ICONS[k] ?? 'globe')} ${esc(SOCIAL_LABELS[k] ?? k)}</a>`).join('')}</p>` : ''}
  ${stackHtml(p)}
  ${pricingHtml(p)}
  ${p.makerName || d.maker ? `<p class="maker">Made by ${d.maker ? `<a href="/makers/${esc(d.maker.id)}">${esc(p.makerName || d.maker.name)}</a>${p.makerVerified ? ' <span class="tick" title="Their OpenProfile names this product">✓</span>' : ''}` : esc(p.makerName)}</p>` : ''}
  <p class="muted small">Launched ${p.launchedAt ? new Date(p.launchedAt).toISOString().slice(0, 10) : 'soon'} · ${p.votes} upvote${p.votes === 1 ? '' : 's'} · <a href="/p/${esc(p.slug)}/opensite.json">OpenSite record</a> · <a href="/p/${esc(p.slug)}/openprofile.md">OpenProfile.md</a></p>
</div>
${live ? `<h2 class="section-h">Share it</h2>${share(ctx.origin, p)}
<details class="card" id="badge"${p.verifiedAt || !d.canEdit ? '' : ' open'}>
  <summary>Add the badge to your site</summary>
  <p class="muted">Put this on your homepage. It shows your live upvote count, and once we see it your link here becomes a followed link and you get the ✓.</p>
  <p><img src="/badge/${esc(p.slug)}.svg" alt="badge" width="200" height="44"> <img src="/badge/${esc(p.slug)}.svg?theme=light" alt="badge, light" width="200" height="44"></p>
  <pre><code>${esc(badgeSnippet(ctx.origin, p))}</code></pre>
  <div class="row"><button class="chip" data-copy="${esc(badgeSnippet(ctx.origin, p))}">Copy badge HTML</button><form method="post" action="/p/${esc(p.slug)}/verify"><button class="chip">I added it: check</button></form></div>
</details>
${d.payments ? `<details class="card" id="feature"><summary>Feature it: ${esc(`$${d.featureUsd}`)} for ${d.featureDays} days</summary>
  <p class="muted">Pinned above today’s board on the homepage for ${d.featureDays} days. Paid in crypto through CoinPay.</p>
  <form method="post" action="/p/${esc(p.slug)}/feature" class="row"><label class="sr" for="chain">Pay with</label><select id="chain" name="chain">${d.chains.map((c) => `<option value="${esc(c)}">${esc(CHAIN_LABELS[c] ?? c)}</option>`).join('')}</select><button class="btn">Pay $${esc(d.featureUsd)}</button></form>
</details>` : ''}
${adUnit('banner_300x250')}` : ''}`,
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
    body: `${d.fresh ? `<p class="note">Here is what we read from ${esc(p.domain)}. Fix anything, then launch. It is in <a href="/me">your launches</a>${p.ownerId ? '' : `; <a href="/p/${esc(p.slug)}/claim">claim it</a> with a DNS record so it stays yours`}.</p>` : ''}
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

export function claimPage(ctx: Ctx, d: { product: Product; record: { name: string; value: string }; owner: boolean; result?: { ok: boolean; looked: string[] } }): string {
  const p = d.product
  const done = d.owner || d.result?.ok
  return layout({
    ctx,
    title: `Claim ${p.name} · built.indie`,
    description: `Prove you own ${p.domain} with a DNS record.`,
    path: `/p/${p.slug}/claim`,
    noindex: true,
    body: `<h1 class="page-h">${done ? `${esc(p.name)} is yours ✓` : `Claim ${esc(p.name)}`}</h1>
${done ? `<p class="note">You own this listing. <a href="/p/${esc(p.slug)}/edit">Edit it</a>, then add the <a href="/p/${esc(p.slug)}#badge">badge</a>.</p>` : `
${p.ownerId ? '<p class="note">Someone already claimed this listing. If you own the domain, adding your record below moves it to you.</p>' : ''}
${d.result && !d.result.ok ? `<p class="note error" role="alert">We did not find the record yet at ${d.result.looked.map((n) => `<code>${esc(n)}</code>`).join(' or ')}. DNS can take a few minutes; try again.</p>` : ''}
<p class="muted">Prove you control <b>${esc(p.domain)}</b>: add this TXT record at your DNS host, then check.</p>
<div class="card">
  <p class="small muted">Type</p><p><code>TXT</code></p>
  <p class="small muted">Name / host</p><div class="address"><code>${esc(d.record.name)}</code><button class="copy" data-copy="${esc(d.record.name.replace(`.${p.domain.replace(/^www\./, '')}`, ''))}">Copy</button></div>
  <p class="small muted">Some DNS hosts want only <code>_built-indie</code> here; others want the full name.</p>
  <p class="small muted">Value</p><div class="address"><code>${esc(d.record.value)}</code><button class="copy" data-copy="${esc(d.record.value)}">Copy</button></div>
  <p class="small muted">A TXT record on ${esc(p.domain.replace(/^www\./, ''))} itself with the same value works too. You can remove it once claimed.</p>
  <form method="post" action="/p/${esc(p.slug)}/claim" data-busy="Asking DNS…"><button class="btn">Check DNS</button></form>
</div>`}`,
  })
}

export function loginPage(ctx: Ctx, d: { next: string | null; sent?: boolean; error?: string; email?: string }): string {
  return layout({
    ctx,
    title: 'Sign in · built.indie',
    description: 'Sign in with a link by email.',
    path: '/login',
    noindex: true,
    body: `<section class="hero narrow"><h1>${d.sent ? 'Check your email' : 'Sign in'}</h1>
${d.sent ? '<p class="lede">If that address can receive mail, a sign-in link is on its way. It works once, for 20 minutes.</p>' : `<p class="lede">No password. We email you a link; a new address makes an account. You need one only to claim and edit a listing. Launching is free and needs nothing.</p>
${d.error ? `<p class="note error" role="alert">${esc(d.error)}</p>` : ''}
<form method="post" action="/login" class="card">
  <input type="hidden" name="next" value="${esc(d.next ?? '')}">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(d.email ?? '')}">
  <p><button class="btn wide">Email me a link</button></p>
</form>`}</section>`,
  })
}

export function mePage(ctx: Ctx, d: { user: User; products: Product[]; apiKey?: string }): string {
  return layout({
    ctx,
    title: 'Your launches · built.indie',
    description: 'Your launches.',
    path: '/me',
    noindex: true,
    body: `<h1 class="page-h">Your launches</h1>
<p class="muted">Signed in as ${esc(d.user.email)}. <form class="inline" method="post" action="/logout"><button class="linkish">Sign out</button></form></p>
${d.products.length ? `<ol class="board">${d.products.map((p) => `<li class="row-item"><a class="row-main" href="/p/${esc(p.slug)}">${logoImg(p)}<span class="row-text"><b>${esc(p.name)}</b><span class="muted">${p.status === 'draft' ? 'draft' : `▲ ${p.votes}`} · ${p.ownerId === d.user.id ? 'claimed ✓' : 'submitted by you, not claimed'}</span></span></a><a class="chip" href="/p/${esc(p.slug)}/edit">Edit</a>${p.ownerId === d.user.id ? '' : `<a class="chip" href="/p/${esc(p.slug)}/claim">Claim</a>`}</li>`).join('')}</ol>` : '<p class="empty">Nothing yet. <a href="/submit">Launch something</a>, or open a listing that is yours and claim it.</p>'}
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
<p class="muted">Everything on the site is an API. Launching and reading need nothing. To edit, sign in, claim your product with a DNS record, and make an API key on <a href="/me">your page</a>.</p>
<div class="card"><h2>API</h2>
<pre>curl -X POST ${o}/api/v1/products -H 'content-type: application/json' \\
  -d '{"url":"yourproduct.com","maker_name":"You"}'
# → { product, claim_url }   free; live at once

curl ${o}/api/v1/products?window=today      # today|week|month|all|new|featured
curl ${o}/api/v1/products/&lt;slug&gt;
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/vote
curl -X POST ${o}/api/v1/preview -d '{"url":"any.site"}' -H 'content-type: application/json'
curl ${o}/api/v1/products/&lt;slug&gt;/claim -H 'authorization: Bearer bi_…'   # the TXT record to add
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/claim -H 'authorization: Bearer bi_…'   # check it
curl -X PATCH ${o}/api/v1/products/&lt;slug&gt; -H 'authorization: Bearer bi_…' \\
  -H 'content-type: application/json' -d '{"tagline":"…","videos":["https://youtu.be/…"]}'
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/refetch -H 'authorization: Bearer bi_…'
curl -X POST ${o}/api/v1/products/&lt;slug&gt;/publish -H 'authorization: Bearer bi_…'</pre>
<p class="muted small">OpenSite (logicsrc.com/docs/opensite): <code>GET /api/v1/sites?url=…</code>, <code>POST /api/v1/sites</code>, and every product at <code>/p/&lt;slug&gt;/opensite.json</code>. OpenProfile: <code>/p/&lt;slug&gt;/openprofile.md</code>, <code>/makers/&lt;id&gt;/openprofile.md</code>.</p></div>
<div class="card" id="cli"><h2>CLI and TUI</h2>
<pre>curl -fsSL ${o}/install.sh | sh                # installs builtindie
builtindie                                    # TUI: today's board, vote, launch
bunx @profullstack/builtindie                 # or run it without installing
bunx @profullstack/builtindie launch yourproduct.com
bunx @profullstack/builtindie top week
bunx @profullstack/builtindie show &lt;slug&gt;
bunx @profullstack/builtindie vote &lt;slug&gt;
BUILTINDIE_KEY=bi_… bunx @profullstack/builtindie claim &lt;slug&gt;   # TXT record, then checks it
bunx @profullstack/builtindie preview any.site --json</pre></div>
<div class="card" id="mcp"><h2>MCP</h2>
<pre>claude mcp add builtindie -- bunx @profullstack/builtindie mcp</pre>
<p class="muted">Tools: <code>launch_product</code>, <code>preview_site</code>, <code>list_products</code>, <code>get_product</code>, <code>upvote</code>, <code>search</code>, and with <code>BUILTINDIE_KEY</code>: <code>claim_product</code>, <code>edit_product</code>, <code>my_products</code>.</p></div>
<div class="card" id="bot"><h2>Our reader</h2>
<p class="muted">We fetch only what a person submits, once, plus a re-read when the maker asks. User agent <code>built.indie/1.0</code>. We honour <code>robots.txt</code> and <code>index.allow: false</code> in <code>/.well-known/opensite.json</code>. Screenshots are taken with headless Chrome.</p></div>
<div class="card"><h2>Make your page read well</h2>
<ul class="muted"><li><code>og:image</code> 1200×630 and an <code>apple-touch-icon</code> or a manifest icon 512×512</li><li><code>/llms.txt</code>: <code># Name</code>, then <code>&gt; one-line summary</code></li><li><code>/.well-known/opensite.json</code> (<a href="https://logicsrc.com/opensite">OpenSite</a>) to say it yourself</li><li><code>/.well-known/openprofile.md</code> (<a href="https://logicsrc.com/openprofile">OpenProfile</a>) with <code>Kind: organization</code> and your accounts</li><li><code>/.well-known/openstack.md</code> (<a href="https://logicsrc.com/docs/openstack">OpenStack.md</a>): we show it as “Built with”</li><li><code>/.well-known/opensaas.json</code> (<a href="https://logicsrc.com/opensaas">OpenSaaS</a>): your plans and your cancel page</li><li><code>/.well-known/openicon.json</code> (<a href="https://logicsrc.com/docs/openicon">OpenIcon</a>) if you publish an icon set</li><li>a YouTube/Vimeo/Loom embed or <code>og:video</code> for your demo</li></ul></div>`,
  })
}

export function messagePage(ctx: Ctx, d: { title: string; message: string; status?: number }): string {
  return layout({ ctx, title: `${d.title} · built.indie`, description: d.message, path: '/', noindex: true, body: `<section class="hero"><h1>${esc(d.title)}</h1><p class="lede">${esc(d.message)}</p><a class="btn" href="/">Home</a></section>` })
}

/** The embeddable badge: live upvotes, or the day's award once it is won. */
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
