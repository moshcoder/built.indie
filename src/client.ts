/**
 * The built.indie API from anywhere: the CLI, the TUI and the MCP server use this.
 * BUILTINDIE_URL points it at another instance; BUILTINDIE_KEY (bi_…) is your
 * account's API key (built.indie/me), for claiming and editing your products.
 */
export type SearchFilters = Partial<{ category: string[]; tag: string[]; has: string[]; stack: string[]; maker: string[]; launched: string; sort: string; page: number; limit: number }>
export type FacetValue = { value: string; label: string; count: number }
export type SearchResult = { total: number; page: number; pages: number; products: (ApiProduct & { categories: string[] })[]; facets?: Record<string, FacetValue[]>; web: string }

export type ApiProduct = {
  slug: string
  name: string
  tagline: string
  description: string
  url: string
  domain: string
  status: string
  votes: number
  reviews?: number
  rating?: number | null
  tags: string[]
  logo: string | null
  card_image: string | null
  screenshot: string | null
  images: string[]
  videos: { kind: string; url: string; embed: string | null }[]
  socials: Record<string, string>
  llms: { url: string; title: string; summary: string } | null
  profile: { url: string; kind: string | null; name: string; headline: string } | null
  maker: { name: string; profile: string | null; verified: boolean; page: string | null } | null
  verified: boolean
  featured_until: string | null
  launched_at: string | null
  page: string
  badge: string
  opensite: string
  openprofile: string
  award?: { day: string; rank: number } | null
}

export type Invites = { link: string; code: string; invited: number; launched: number; credits: number; karma_credits?: number; used: number; feature_days: number }

export type KarmaInfo = { total: number; week: number; per_credit: number; next_credit_in: number; credits: { earned: number; used: number }; events: { action: string; label: string; ref: string; points: number; at: string }[]; how_to_earn: { action: string; points: number; rule: string }[]; leaderboard: string }
export type BoardRows = { board: string; period: string; total: number; rows: { rank: number | null; id: string; name: string; value: number; badges: { emoji: string; label: string }[]; url: string }[]; web: string }
export type ApiComment = { id: string; parent: string | null; body: string | null; deleted: boolean; author: string | null; karma: number; maker: boolean; at: string; url: string; mine?: boolean }
export type ApiReview = { rating: number; body: string; author: string; karma: number; at: string }

export type Launched = { product: ApiProduct; claim_url?: string; existing?: boolean }
export type ClaimRecord = { type: string; name: string; value: string }

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class BuiltIndieClient {
  readonly base: string
  constructor(base = process.env.BUILTINDIE_URL ?? 'https://built.indie.pit.world', private readonly key = process.env.BUILTINDIE_KEY, private readonly doFetch: typeof fetch = fetch) {
    this.base = base.replace(/\/+$/, '')
  }

  private async call<T>(method: string, path: string, body?: unknown, key = this.key): Promise<T> {
    const response = await this.doFetch(this.base + path, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { authorization: `Bearer ${key}` } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90_000),
    })
    const data = (await response.json().catch(() => ({}))) as { error?: string }
    if (!response.ok) throw new ApiError(data.error ?? `built.indie answered ${response.status}`, response.status)
    return data as T
  }

  launch(url: string, o: { makerName?: string; makerProfile?: string; name?: string; tagline?: string; description?: string; tags?: string[]; videos?: string[]; publish?: boolean } = {}): Promise<Launched> {
    return this.call('POST', '/api/v1/products', { url, maker_name: o.makerName, maker_profile: o.makerProfile, name: o.name, tagline: o.tagline, description: o.description, tags: o.tags, videos: o.videos, publish: o.publish ?? true })
  }

  preview(url: string): Promise<Record<string, unknown>> {
    return this.call('POST', '/api/v1/preview', { url })
  }

  list(window = 'today', limit = 30): Promise<{ window: string; products: ApiProduct[] }> {
    return this.call('GET', `/api/v1/products?window=${encodeURIComponent(window)}&limit=${limit}`)
  }

  tags(): Promise<{ tags: { tag: string; count: number }[] }> {
    return this.call('GET', '/api/v1/tags')
  }

  tagged(tag: string, limit = 30): Promise<{ tag: string; products: ApiProduct[] }> {
    return this.call('GET', `/api/v1/products?tag=${encodeURIComponent(tag)}&limit=${limit}`)
  }

  /** Search with filters; the answer carries the facets (counts per category, tag, stack…) to narrow further. */
  search(q: string, filters: SearchFilters = {}): Promise<SearchResult> {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    for (const k of ['category', 'tag', 'has', 'stack', 'maker'] as const) for (const v of filters[k] ?? []) p.append(k, v)
    for (const k of ['launched', 'sort'] as const) if (filters[k]) p.set(k, filters[k]!)
    if (filters.page) p.set('page', String(filters.page))
    if (filters.limit) p.set('limit', String(filters.limit))
    return this.call('GET', `/api/v1/search?${p}`)
  }

  categories(): Promise<{ categories: { key: string; label: string; count: number; page: string }[]; tags: { tag: string; count: number; page: string }[] }> {
    return this.call('GET', '/api/v1/categories')
  }

  product(slug: string): Promise<ApiProduct> {
    return this.call('GET', `/api/v1/products/${encodeURIComponent(slug)}`)
  }

  vote(slug: string): Promise<{ slug: string; votes: number; counted: boolean }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/vote`, {})
  }

  private needKey(key?: string): string {
    const k = key ?? this.key
    if (!k) throw new ApiError('Set BUILTINDIE_KEY to your API key: sign in at built.indie.pit.world/me and make one', 401)
    return k
  }

  claimRecord(slug: string): Promise<{ owner: boolean; record: ClaimRecord; badge: string; markdown: string }> {
    return this.call('GET', `/api/v1/products/${encodeURIComponent(slug)}/claim`, undefined, this.needKey())
  }

  claim(slug: string): Promise<{ claimed: boolean; method?: 'dns' | 'badge'; looked: string[]; record: ClaimRecord; badge: string; markdown?: string }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/claim`, {}, this.needKey())
  }

  me(): Promise<{ email: string; products: (ApiProduct & { owner: boolean })[]; invite: Invites }> {
    return this.call('GET', '/api/v1/me', undefined, this.needKey())
  }

  /** Your invite link and credits: each new member it brings in who launches earns a free Featured week. */
  invites(): Promise<Invites> {
    return this.call('GET', '/api/v1/invites', undefined, this.needKey())
  }

  /** Spend one invite credit to feature a listing you own. */
  credit(slug: string): Promise<{ featured_until: string; credits: number }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/credit`, {}, this.needKey())
  }

  /** Pay to feature a listing you own: opens a CoinPay checkout session (any coin or PayPal); send the buyer to checkout_url. */
  feature(slug: string, email?: string): Promise<{ checkout_url: string; checkout_session_id: string; methods: string[]; payment: string; usd: number; days: number }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/feature`, email ? { email } : {}, this.needKey())
  }

  edit(slug: string, patch: Record<string, unknown>, key?: string): Promise<ApiProduct> {
    return this.call('PATCH', `/api/v1/products/${encodeURIComponent(slug)}`, patch, this.needKey(key))
  }

  act(slug: string, action: 'publish' | 'refetch', key?: string): Promise<ApiProduct> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/${action}`, {}, this.needKey(key))
  }

  /** Your karma: total, this week, history, and how far to the next free Featured week. */
  karma(): Promise<KarmaInfo> {
    return this.call('GET', '/api/v1/karma', undefined, this.needKey())
  }

  leaderboard(board = 'karma', period = 'week', limit = 25): Promise<BoardRows> {
    return this.call('GET', `/api/v1/leaderboard?board=${encodeURIComponent(board)}&period=${encodeURIComponent(period)}&limit=${limit}`)
  }

  comments(slug: string): Promise<{ slug: string; comments: ApiComment[] }> {
    return this.call('GET', `/api/v1/products/${encodeURIComponent(slug)}/comments`)
  }

  comment(slug: string, body: string, parent?: string): Promise<{ comment: ApiComment; karma: number }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/comments`, { body, ...(parent ? { parent } : {}) }, this.needKey())
  }

  deleteComment(id: string): Promise<{ deleted: boolean }> {
    return this.call('DELETE', `/api/v1/comments/${encodeURIComponent(id)}`, undefined, this.needKey())
  }

  reviews(slug: string): Promise<{ slug: string; rating: number | null; count: number; reviews: ApiReview[] }> {
    return this.call('GET', `/api/v1/products/${encodeURIComponent(slug)}/reviews`)
  }

  review(slug: string, rating: number, body: string): Promise<{ review: { rating: number; body: string }; product: { rating: number | null; count: number }; karma: number }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/reviews`, { rating, body }, this.needKey())
  }

  verify(slug: string): Promise<{ verified: boolean }> {
    return this.call('POST', `/api/v1/products/${encodeURIComponent(slug)}/verify`, {})
  }
}
