/**
 * Browse and search: one query over every live launch, with facets.
 *
 * A launch's tags are whatever its page or its maker said (often nothing), so
 * we also file each one under a fixed set of categories, read from its tags,
 * name, tagline and description. Every listing lands somewhere, and the same
 * twenty words mean the same thing everywhere.
 *
 * Facets work the usual way: values within a facet are OR'd, facets are AND'd,
 * and each facet counts what you would get by changing only that facet.
 */
import type { Product } from './db.js'

export type Category = { key: string; label: string; words: string[] }

export const CATEGORIES: Category[] = [
  { key: 'developer-tools', label: 'Developer tools', words: ['developer', 'developers', 'devtools', 'dev tools', 'api', 'sdk', 'cli', 'code', 'coding', 'github', 'npm', 'open source', 'programming', 'terminal', 'mcp', 'cicd', 'ci/cd', 'git'] },
  { key: 'ai', label: 'AI', words: ['ai', 'llm', 'llms', 'gpt', 'agent', 'agents', 'agentic', 'machine learning', 'artificial intelligence', 'chatbot', 'claude', 'openai', 'inference', 'gpu'] },
  { key: 'crypto', label: 'Crypto & web3', words: ['crypto', 'cryptocurrency', 'bitcoin', 'blockchain', 'web3', 'usdc', 'ethereum', 'solana', 'defi', 'nft', 'multisig', 'escrow', 'stablecoin'] },
  { key: 'finance', label: 'Finance & payments', words: ['finance', 'payment', 'payments', 'invoice', 'invoicing', 'billing', 'bank', 'banking', 'money', 'tax', 'taxes', 'accounting', 'stocks', 'trading', 'invest', 'investing', 'payment gateway'] },
  { key: 'security', label: 'Security & privacy', words: ['security', 'cybersecurity', 'malware', 'vulnerability', 'vulnerabilities', 'threat', 'threats', 'privacy', 'encryption', 'encrypted', 'scanner', 'intrusion', 'firewall', 'vpn', 'backdoor', 'exposure management'] },
  { key: 'productivity', label: 'Productivity', words: ['productivity', 'utilities', 'utility', 'workflow', 'automation', 'automate', 'notes', 'calendar', 'todo', 'bookmarks', 'sync', 'pdf'] },
  { key: 'marketing', label: 'Marketing & SEO', words: ['marketing', 'seo', 'newsletter', 'newsletters', 'social media', 'ads', 'advertising', 'outreach', 'growth', 'analytics', 'leads', 'programmatic seo', 'affiliate', 'webring'] },
  { key: 'media', label: 'Video & streaming', words: ['entertainment', 'movies', 'movie', 'video', 'videos', 'streaming', 'tv', 'iptv', 'torrent', 'torrents', 'film', 'films', 'youtube', 'ebooks', 'podcast', 'podcasts'] },
  { key: 'music', label: 'Music & audio', words: ['music', 'audio', 'songs', 'radio', 'playlist', 'playlists', 'genre', 'genres', 'bands', 'concerts'] },
  { key: 'news', label: 'News & publishing', words: ['news', 'blog', 'blogs', 'blogging', 'rss', 'feeds', 'journalism', 'publishing', 'magazine', 'content automation'] },
  { key: 'education', label: 'Education', words: ['education', 'learn', 'learning', 'course', 'courses', 'training', 'tutorial', 'tutorials', 'school', 'students', 'kids'] },
  { key: 'business', label: 'Business & SaaS', words: ['business', 'saas', 'b2b', 'crm', 'startup', 'startups', 'enterprise', 'small business', 'compliance', 'license', 'government'] },
  { key: 'jobs', label: 'Jobs & freelance', words: ['jobs', 'job', 'hiring', 'freelance', 'freelancers', 'gig', 'gig economy', 'remote work', 'career', 'resume', 'recruiting'] },
  { key: 'shopping', label: 'Shopping & deals', words: ['shopping', 'coupons', 'coupon', 'deals', 'discounts', 'promo codes', 'ecommerce', 'e-commerce', 'savings', 'marketplace'] },
  { key: 'social', label: 'Social & community', words: ['social', 'community', 'communities', 'chat', 'forum', 'forums', 'messaging', 'messenger', 'dating', 'friends', 'sms'] },
  { key: 'games', label: 'Games', words: ['game', 'games', 'gaming', 'esports', 'puzzle', 'play both sides', 'rpg', 'operatives', 'multiplayer', 'arcade'] },
  { key: 'sports', label: 'Sports', words: ['sports', 'sport', 'youth-sports', 'athlete', 'athletes', 'league', 'leagues', 'nba', 'nfl', 'mlb', 'nhl', 'soccer', 'football', 'basketball', 'baseball', 'hockey', 'highlight reel', 'highlights', 'fixtures'] },
  { key: 'design', label: 'Design & images', words: ['design', 'designer', 'image', 'images', 'photo', 'photos', 'background', 'backgrounds', 'icons', 'logo', 'logos', 'graphics', 'illustration', 'art', 'tattoo'] },
  { key: 'lifestyle', label: 'Lifestyle & health', words: ['lifestyle', 'health', 'fitness', 'food', 'recipe', 'recipes', 'travel', 'family', 'ancestry', 'genealogy', 'home', 'pets', 'cannabis', 'weed', 'delivery', 'cigars', 'cigar', 'tattoo', 'detailing', 'bbq'] },
  { key: 'data', label: 'Data & directories', words: ['directory', 'directories', 'dataset', 'datasets', 'database', 'databases', 'search engine', 'listings', 'index', 'scraper', 'lookup'] },
  { key: 'hosting', label: 'Hosting & infrastructure', words: ['hosting', 'server', 'servers', 'vps', 'dns', 'domains', 'domain names', 'cloud', 'seedbox', 'bare metal', 'cdn', 'deploy', 'deployment', 'infrastructure'] },
]
const OTHER: Category = { key: 'other', label: 'Other', words: [] }
export const CATEGORY_LABELS: Record<string, string> = Object.fromEntries([...CATEGORIES, OTHER].map((c) => [c.key, c.label]))

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const MATCHERS = CATEGORIES.map((c) => ({ key: c.key, re: new RegExp(`(?:^|[^a-z0-9])(?:${c.words.map(escRe).join('|')})(?=$|[^a-z0-9])`, 'g') }))

/**
 * Up to three categories for a launch, best first. Tags and the tagline say
 * what it is; the description only breaks ties, so a passing mention of
 * "payments" in a long paragraph does not file a music site under finance.
 */
export function categorize(p: Pick<Product, 'tags' | 'name' | 'tagline' | 'description'>): string[] {
  const strong = ` ${[...p.tags, p.name, p.tagline].join(' · ').toLowerCase()} `
  const weak = ` ${p.description.toLowerCase()} `
  const scored = MATCHERS.map((m) => ({ key: m.key, score: 3 * (strong.match(m.re)?.length ?? 0) + Math.min(2, weak.match(m.re)?.length ?? 0) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
  // A lone weak hit is noise unless it is all we have.
  const keep = scored.filter((s, i) => i === 0 || s.score >= 2).slice(0, 3)
  return keep.length ? keep.map((s) => s.key) : [OTHER.key]
}

/** Things a launch has, each one a filter. */
export const HAS: Record<string, { label: string; test: (p: Product, now: number) => boolean }> = {
  verified: { label: '✓ Links back (verified)', test: (p) => Boolean(p.verifiedAt) },
  claimed: { label: 'Claimed by its owner', test: (p) => Boolean(p.ownerId) },
  featured: { label: '★ Featured now', test: (p, now) => Boolean(p.featuredUntil && p.featuredUntil > now) },
  video: { label: 'Has a video', test: (p) => p.videos.length > 0 },
  screenshots: { label: 'Has screenshots', test: (p) => Boolean(p.screenshot || p.images.length) },
  llms: { label: 'llms.txt', test: (p) => Boolean(p.llms) },
  opensite: { label: 'OpenSite', test: (p) => p.record?.source === 'declared' },
  openprofile: { label: 'OpenProfile', test: (p) => Boolean(p.profile) },
  openstack: { label: 'OpenStack (built with)', test: (p) => Boolean(p.extras.stack) },
  opensaas: { label: 'OpenSaaS (pricing)', test: (p) => Boolean(p.extras.pricing) },
  maker: { label: 'Names its maker', test: (p) => Boolean(p.makerName || p.makerId) },
}

const DAY = 86400_000
export const LAUNCHED: Record<string, { label: string; ms: number }> = {
  today: { label: 'Last 24 hours', ms: DAY },
  week: { label: 'Past week', ms: 7 * DAY },
  month: { label: 'Past month', ms: 30 * DAY },
  year: { label: 'Past year', ms: 365 * DAY },
}

export const SORTS = { relevance: 'Best match', top: 'Most upvoted', new: 'Newest', name: 'Name A–Z' } as const
export type Sort = keyof typeof SORTS

export type Query = { q: string; category: string[]; tag: string[]; stack: string[]; has: string[]; maker: string[]; launched: string | null; sort: Sort; page: number }
export type FacetName = 'category' | 'tag' | 'stack' | 'has' | 'maker' | 'launched'
export type FacetValue = { value: string; label: string; count: number }
export type Facets = Record<FacetName, FacetValue[]>
export type Chip = { facet: FacetName | 'q'; value: string; label: string }
export type Result = { query: Query; total: number; products: Product[]; facets: Facets; chips: Chip[]; categories: Map<string, string[]>; limit: number }

/** The order facets appear in, with their headings. */
export const FACETS: { name: FacetName; label: string; multi: boolean; top?: number }[] = [
  { name: 'category', label: 'Category', multi: true },
  { name: 'tag', label: 'Tags', multi: true, top: 30 },
  { name: 'launched', label: 'Launched', multi: false },
  { name: 'has', label: 'Has', multi: true },
  { name: 'stack', label: 'Built with', multi: true, top: 20 },
  { name: 'maker', label: 'Maker', multi: true, top: 20 },
]

const clean = (v: string, max = 60) => v.trim().slice(0, max)
const listOf = (p: URLSearchParams, k: string, split: boolean) =>
  [...new Set(p.getAll(k).flatMap((v) => (split ? v.split(',') : [v])).map((v) => clean(v)).filter(Boolean))].slice(0, 20)

/** A query from a URL's parameters (pages and the API take the same ones). */
export function parseQuery(params: URLSearchParams | Record<string, string | string[] | undefined>): Query {
  const p = params instanceof URLSearchParams ? params : new URLSearchParams(Object.entries(params).flatMap(([k, v]) => (v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)]))))
  const q = clean(p.get('q') ?? '', 80)
  const sort = (p.get('sort') ?? '') as Sort
  const launched = p.get('launched') ?? ''
  return {
    q,
    category: listOf(p, 'category', true).filter((c) => c in CATEGORY_LABELS),
    tag: listOf(p, 'tag', true).map((t) => t.toLowerCase()),
    stack: listOf(p, 'stack', false),
    has: listOf(p, 'has', true).filter((h) => h in HAS),
    maker: listOf(p, 'maker', false),
    launched: launched in LAUNCHED ? launched : null,
    sort: sort in SORTS && (sort !== 'relevance' || q) ? sort : q ? 'relevance' : 'top',
    page: Math.min(500, Math.max(1, Number(p.get('page')) || 1)),
  }
}

/** The query as URL parameters; defaults left out so links stay short. */
export function queryString(q: Query): string {
  const p = new URLSearchParams()
  if (q.q) p.set('q', q.q)
  for (const k of ['category', 'tag', 'has', 'stack', 'maker'] as const) for (const v of q[k]) p.append(k, v)
  if (q.launched) p.set('launched', q.launched)
  if (q.sort !== (q.q ? 'relevance' : 'top')) p.set('sort', q.sort)
  if (q.page > 1) p.set('page', String(q.page))
  return p.toString()
}

/** The same query with one facet value switched on or off (back to page 1). */
export function toggle(q: Query, facet: FacetName, value: string): Query {
  const next: Query = { ...q, page: 1 }
  if (facet === 'launched') next.launched = q.launched === value ? null : value
  else next[facet] = q[facet].includes(value) ? q[facet].filter((v) => v !== value) : [...q[facet], value]
  return next
}

export const isEmpty = (q: Query) => !q.q && !q.launched && !q.category.length && !q.tag.length && !q.stack.length && !q.has.length && !q.maker.length

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length >= 2)

export function search(all: Product[], query: Query, o: { limit?: number; now?: number } = {}): Result {
  const now = o.now ?? Date.now()
  const limit = o.limit ?? 30
  const categories = new Map(all.map((p) => [p.id, categorize(p)]))
  const stackOf = (p: Product) => [...new Set((p.extras.stack?.items ?? []).map((i) => i.name))]

  // Words: every one must appear somewhere; where it appears decides the score.
  // A term matches at the start of a word: "crypt" finds crypto, "ai" does not find email.
  const terms = words(query.q).map((t) => ({ t, re: new RegExp(`(?:^|[^a-z0-9])${escRe(t)}`) }))
  const scores = new Map<string, number>()
  const textMatch = (p: Product) => {
    if (!terms.length) return true
    const name = p.name.toLowerCase()
    const fields = [
      [name, 8],
      [p.tags.join(' ').toLowerCase(), 5],
      [(categories.get(p.id) ?? []).map((c) => CATEGORY_LABELS[c]).join(' ').toLowerCase(), 4],
      [p.domain.toLowerCase(), 4],
      [p.tagline.toLowerCase(), 3],
      [`${p.makerName} ${stackOf(p).join(' ')}`.toLowerCase(), 2],
      [p.description.toLowerCase(), 1],
    ] as const
    let score = 0
    for (const { re } of terms) {
      const hit = fields.reduce((best, [text, w]) => (re.test(text) ? Math.max(best, w) : best), 0)
      if (!hit) return false
      score += hit
    }
    if (name === query.q.toLowerCase()) score += 20
    else if (name.startsWith(terms[0]!.t)) score += 6
    scores.set(p.id, score)
    return true
  }

  const tests: Record<FacetName, (p: Product) => boolean> = {
    category: (p) => !query.category.length || query.category.some((c) => categories.get(p.id)!.includes(c)),
    tag: (p) => !query.tag.length || query.tag.some((t) => p.tags.includes(t)),
    stack: (p) => !query.stack.length || stackOf(p).some((s) => query.stack.includes(s)),
    has: (p) => query.has.every((h) => HAS[h]!.test(p, now)),
    maker: (p) => !query.maker.length || query.maker.includes(p.makerName),
    launched: (p) => !query.launched || Boolean(p.launchedAt && p.launchedAt >= now - LAUNCHED[query.launched]!.ms),
  }
  const base = all.filter(textMatch)
  const names = Object.keys(tests) as FacetName[]
  const passes = (p: Product, except?: FacetName) => names.every((n) => n === except || tests[n](p))

  // Each facet counts over everything the other facets allow.
  const tally = (except: FacetName, valuesOf: (p: Product) => string[]) => {
    const n = new Map<string, number>()
    for (const p of base) if (passes(p, except)) for (const v of valuesOf(p)) n.set(v, (n.get(v) ?? 0) + 1)
    return n
  }
  const ranked = (n: Map<string, number>, label: (v: string) => string, top = 100, selected: string[] = []) =>
    [...n]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .filter(([v], i) => i < top || selected.includes(v))
      .map(([value, count]) => ({ value, label: label(value), count }))
  const withSelected = (values: FacetValue[], selected: string[], label: (v: string) => string) => [...values, ...selected.filter((s) => !values.some((v) => v.value === s)).map((s) => ({ value: s, label: label(s), count: 0 }))]

  const hasCounts = new Map<string, number>()
  for (const p of base) if (passes(p, 'has')) for (const [k, h] of Object.entries(HAS)) if (query.has.filter((x) => x !== k).every((x) => HAS[x]!.test(p, now)) && h.test(p, now)) hasCounts.set(k, (hasCounts.get(k) ?? 0) + 1)
  const launchedCounts = new Map<string, number>()
  for (const p of base) if (passes(p, 'launched')) for (const [k, l] of Object.entries(LAUNCHED)) if (p.launchedAt && p.launchedAt >= now - l.ms) launchedCounts.set(k, (launchedCounts.get(k) ?? 0) + 1)

  const facets: Facets = {
    category: withSelected(ranked(tally('category', (p) => categories.get(p.id)!), (v) => CATEGORY_LABELS[v] ?? v), query.category, (v) => CATEGORY_LABELS[v] ?? v),
    tag: withSelected(ranked(tally('tag', (p) => p.tags), (v) => v, 30, query.tag), query.tag, (v) => v),
    stack: withSelected(ranked(tally('stack', stackOf), (v) => v, 20, query.stack), query.stack, (v) => v),
    maker: withSelected(ranked(tally('maker', (p) => (p.makerName ? [p.makerName] : [])), (v) => v, 20, query.maker), query.maker, (v) => v),
    has: Object.keys(HAS).filter((k) => hasCounts.get(k) || query.has.includes(k)).map((k) => ({ value: k, label: HAS[k]!.label, count: hasCounts.get(k) ?? 0 })),
    launched: Object.keys(LAUNCHED).filter((k) => launchedCounts.get(k) || query.launched === k).map((k) => ({ value: k, label: LAUNCHED[k]!.label, count: launchedCounts.get(k) ?? 0 })),
  }

  const matched = base.filter((p) => passes(p))
  const by: Record<Sort, (a: Product, b: Product) => number> = {
    relevance: (a, b) => (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) || b.votes - a.votes,
    top: (a, b) => b.votes - a.votes || (b.launchedAt ?? 0) - (a.launchedAt ?? 0),
    new: (a, b) => (b.launchedAt ?? 0) - (a.launchedAt ?? 0),
    name: (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }),
  }
  matched.sort(by[query.sort])

  const chips: Chip[] = [
    ...(query.q ? [{ facet: 'q' as const, value: query.q, label: `“${query.q}”` }] : []),
    ...query.category.map((v) => ({ facet: 'category' as const, value: v, label: CATEGORY_LABELS[v] ?? v })),
    ...query.tag.map((v) => ({ facet: 'tag' as const, value: v, label: `#${v}` })),
    ...(query.launched ? [{ facet: 'launched' as const, value: query.launched, label: LAUNCHED[query.launched]!.label }] : []),
    ...query.has.map((v) => ({ facet: 'has' as const, value: v, label: HAS[v]!.label })),
    ...query.stack.map((v) => ({ facet: 'stack' as const, value: v, label: `Built with ${v}` })),
    ...query.maker.map((v) => ({ facet: 'maker' as const, value: v, label: `By ${v}` })),
  ]
  const start = (query.page - 1) * limit
  return { query, total: matched.length, products: matched.slice(start, start + limit), facets, chips, categories, limit }
}
