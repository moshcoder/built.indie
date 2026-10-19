/**
 * What built.indie does, once, for every surface: the web pages, the JSON API,
 * the CLI and the MCP server all end up here.
 *
 *   submit   URL in, a listing out: everything fetched, pictures saved. Free.
 *            Anonymous launches go live at once; a signed-in submitter checks a draft first.
 *   publish  the draft goes live on today's board
 *   claim    the domain's owner proves it (a DNS TXT record, or the badge with their token) and takes the listing
 *   refetch  read the homepage again (the maker changed their logo)
 *   verify   the maker put our badge on their site: a followed link back
 *   feature  pay in crypto (CoinPay) to sit on top for a week
 *
 * Products are described in the LogicSRC open specs: each one is an OpenSite
 * record (logicsrc.com/docs/opensite) and an OpenProfile.md with Kind
 * organization (logicsrc.com/docs/openprofile); a maker is an OpenProfile.md
 * of their own, which we read and link to.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Resolver } from 'node:dns/promises'
import { keyedSection, listSection, makeOpenProfile, renderOpenProfile } from '@profullstack/openprofile'
import { autofetch, clip, FetchError, normalizeUrl, readProfile, safeFetch, SOCIAL_KINDS, videoFrom, type FetchOptions, type SiteInfo, type Video } from './fetch.js'
import { Media, screenshot } from './media.js'
import { dayOf, makerIdFor, newId, Store, type Product, type User } from './db.js'

export class InputError extends Error {
  constructor(message: string, readonly field?: string) {
    super(message)
  }
}

export type CoinPayConfig = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type Config = {
  origin: string
  coinpay: CoinPayConfig | null
  featureUsd: number
  featureDays: number
  chains: string[]
  fetch?: FetchOptions
  screenshots?: boolean
  /** Secret behind each person's claim token. */
  claimSecret?: string
  /** TXT lookups; tests pass their own. */
  resolveTxt?: (name: string) => Promise<string[][]>
}

/** The record an owner adds: `_built-indie.<domain> TXT "built-indie-verify=<token>"` (or the same on the domain itself). */
export const CLAIM_LABEL = '_built-indie'
export const CLAIM_PREFIX = 'built-indie-verify='

/**
 * TXT records as public resolvers see them: every answer from 1.1.1.1 and 9.9.9.9, merged.
 * One Resolver per server on purpose: Bun 1.4's node:dns Resolver given two servers
 * answers ENOTFOUND for a record each of them serves alone, so no claim could succeed.
 * And fresh Resolvers per lookup: a long-lived one caches NXDOMAIN for the zone's SOA
 * minimum (often 30 min), so a maker who checks before adding the record stays refused.
 */
const publicDns = () =>
  ['1.1.1.1', '9.9.9.9'].map((server) => {
    const r = new Resolver({ timeout: 4000, tries: 2 })
    r.setServers([server])
    return r
  })
export async function publicTxt(name: string, resolvers: Pick<Resolver, 'resolveTxt'>[] = publicDns()): Promise<string[][]> {
  const answers = await Promise.all(resolvers.map((r) => r.resolveTxt(name).catch(() => [] as string[][])))
  return answers.flat()
}

export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDT_POL: 'USDT on Polygon',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
}
export const DEFAULT_CHAINS = Object.keys(CHAIN_LABELS)
export const SETTLED = new Set(['paid', 'completed', 'confirmed', 'forwarded', 'succeeded', 'settled'])

export type Edit = Partial<{ name: string; tagline: string; description: string; tags: string[] | string; makerName: string; makerProfile: string; videos: string[] | string; socials: Record<string, string>; remove: string[] | string }>

const list = (v: string[] | string | undefined) => (Array.isArray(v) ? v : String(v ?? '').split(/[\n,]+/)).map((s) => s.trim()).filter(Boolean)

export class BuiltIndie {
  constructor(readonly store: Store, readonly media: Media, readonly config: Config) {}

  /** A product page's public address. */
  link(p: Pick<Product, 'slug'>): string {
    return `${this.config.origin}/p/${p.slug}`
  }

  /** Read the URL and make a draft. A URL already live comes back as `existing` instead. `unlimited` (the admin) skips the hourly cap. */
  async submit(input: { url: string; makerName?: string; makerProfile?: string }, submitter: string, user: User | null = null, unlimited = false): Promise<{ product: Product; existing: boolean }> {
    let url: URL
    try {
      url = normalizeUrl(input.url)
    } catch (e) {
      throw new InputError((e as Error).message, 'url')
    }
    const already = this.store.byUrl(url.href)
    if (already?.status === 'live') return { product: already, existing: true }
    if (!unlimited && this.store.submissionsFrom(submitter, Date.now() - 3600_000) >= 10) throw new InputError('That is a lot of launches in an hour. Try again later.')
    const info = await this.read(url.href)
    const id = newId()
    const pictures = await this.pictures(id, info)
    const product = this.store.create(
      {
        id,
        slug: this.store.freeSlug(info.name),
        url: info.url,
        domain: info.domain,
        name: info.name,
        tagline: info.tagline,
        description: info.description,
        ...pictures,
        videos: info.videos,
        socials: info.socials,
        tags: info.tags,
        themeColor: info.themeColor,
        llms: info.llms,
        profile: info.profile,
        record: this.recordFrom(info),
        extras: { stack: info.stack, pricing: info.pricing, openicon: info.openicon },
        makerName: clip(input.makerName ?? '', 60),
        makerProfile: null,
        submitterUser: user?.id ?? null,
        status: user ? 'draft' : 'live',
      },
      submitter,
    )
    if (input.makerProfile?.trim()) await this.setMaker(product, input.makerProfile, input.makerName).catch(() => {})
    return { product: this.store.product(id)!, existing: false }
  }

  /** The TXT value this person puts in DNS to claim this product. Stable, so a record added yesterday still counts. */
  claimToken(p: Product, user: User): string {
    return createHmac('sha256', this.config.claimSecret ?? 'built.indie').update(`claim:${user.id}:${p.domain}`).digest('base64url').slice(0, 24)
  }

  /**
   * Two proofs, either one claims it: the TXT record at _built-indie.<domain> (or on the
   * domain itself, and its apex for www), or, failing DNS, our badge on the homepage
   * carrying this person's badge id (`/images.svg?id=<id>`, the easy way). Kept for
   * badges already placed: `/badge/<slug>.svg?claim=<token>`, or the bare
   * `built-indie-verify=<token>` anywhere in the HTML, e.g. a meta tag. A badge that
   * claims also earns the followed link and the ✓, as `verify` would.
   */
  async claim(p: Product, user: User): Promise<{ ok: boolean; looked: string[]; method?: 'dns' | 'badge' }> {
    if (p.status === 'hidden') throw new InputError('This product was taken down.')
    if (p.ownerId === user.id) return { ok: true, looked: [] }
    const token = this.claimToken(p, user)
    const want = `${CLAIM_PREFIX}${token}`
    const bare = p.domain.replace(/^www\./, '')
    const names = [...new Set([`${CLAIM_LABEL}.${bare}`, bare, p.domain])]
    const looked = [...names, p.url]
    const lookup = this.config.resolveTxt ?? publicTxt
    for (const name of names) {
      const records = await lookup(name).catch(() => [] as string[][])
      if (records.some((chunks) => chunks.join('').trim() === want)) {
        this.store.claim(p.id, user.id)
        return { ok: true, looked, method: 'dns' }
      }
    }
    const html = await this.homepage(p)
    const own = this.badgeIds(html).some((id) => {
      const b = this.store.badge(id)
      return b?.productId === p.id && b.userId === user.id
    })
    if (own) {
      this.store.claim(p.id, user.id)
      this.store.setVerified(p.id, Date.now())
      return { ok: true, looked, method: 'badge' }
    }
    if (this.hasClaimBadge(html, token)) {
      this.store.claim(p.id, user.id)
      if (this.linksBack(html)) this.store.setVerified(p.id, Date.now())
      return { ok: true, looked, method: 'badge' }
    }
    return { ok: false, looked }
  }

  /** The product's homepage HTML, read the safe way (no private addresses, robots honoured); '' if it will not load. */
  private async homepage(p: Product): Promise<string> {
    const r = await safeFetch(p.url, { ...this.config.fetch, accept: 'text/html' }).catch(() => null)
    return r && r.status < 300 ? new TextDecoder().decode(r.body) : ''
  }

  private ourHosts(): string {
    return `(?:${new URL(this.config.origin).hostname.replace(/\./g, '\\.')}|built\\.indie)`
  }

  /** A followed-link-worthy link back to us. */
  private linksBack(html: string): boolean {
    return new RegExp(`href=["']?https?://${this.ourHosts()}(/|["'])`, 'i').test(html)
  }

  /** Every link or image URL in the page that points at our host. */
  private ourUrls(html: string): string[] {
    if (!html) return []
    return [...html.matchAll(new RegExp(`(?:href|src)\\s*=\\s*["']?((?:https?:)?//${this.ourHosts()}/[^"'\\s>]*)`, 'gi'))].map((m) => m[1]!)
  }

  /** The ids of every `/images.svg?id=<id>` badge on our host in the page. */
  badgeIds(html: string): string[] {
    const ids = this.ourUrls(html).map((u) => u.match(/\/images\.svg\?(?:[^#]*?(?:&|&amp;))?id=([A-Za-z0-9_-]+)/)?.[1])
    return [...new Set(ids.filter((id): id is string => Boolean(id)))]
  }

  /** A link or image on our host whose URL carries claim=<token>, or the bare verify string anywhere. */
  private hasClaimBadge(html: string, token: string): boolean {
    if (!html) return false
    const exact = (prefix: string) => new RegExp(`${prefix}${token}(?![A-Za-z0-9_-])`)
    if (exact(CLAIM_PREFIX).test(html)) return true
    return this.ourUrls(html).some((u) => exact('[?&](?:amp;)?claim=').test(u))
  }

  private async read(url: string): Promise<SiteInfo> {
    try {
      return await autofetch(url, this.config.fetch)
    } catch (e) {
      throw new InputError(e instanceof FetchError ? e.message : `Could not read that site: ${e instanceof Error ? e.message : e}`, 'url')
    }
  }

  /** Logo, card image, up to four screenshots from the page, and our own screenshot of the homepage. */
  private async pictures(id: string, info: SiteInfo) {
    const o = this.config.fetch ?? {}
    const [logo, og, shot, ...found] = await Promise.all([
      this.media.save(id, 'logo', info.logo, o),
      this.media.save(id, 'card', info.ogImage, o),
      this.config.screenshots === false ? null : screenshot(info.url).then((png) => (png ? this.media.write(id, 'home.png', png, { width: 1280, height: 800 }) : null)),
      ...info.images.slice(0, 6).map((src, i) => this.media.save(id, `shot-${i + 1}`, src, { ...o, minSide: 200 })),
    ])
    return {
      logo: logo?.file ?? null,
      ogImage: og?.file ?? null,
      screenshot: shot?.file ?? null,
      images: found.filter((f): f is NonNullable<typeof f> => Boolean(f)).slice(0, 4).map((f) => f.file),
    }
  }

  publish(p: Product): Product {
    if (p.status === 'hidden') throw new InputError('This product was taken down.')
    if (!p.name.trim()) throw new InputError('Give it a name', 'name')
    return this.store.update(p.id, { status: 'live' })!
  }

  async refetch(p: Product): Promise<Product> {
    const info = await this.read(p.url)
    await this.media.remove(p.id)
    const pictures = await this.pictures(p.id, info)
    return this.store.update(p.id, { ...pictures, videos: info.videos, socials: info.socials, llms: info.llms, profile: info.profile, record: this.recordFrom(info), extras: { stack: info.stack, pricing: info.pricing, openicon: info.openicon }, themeColor: info.themeColor, ...(info.tags.length && !p.tags.length ? { tags: info.tags } : {}) })!
  }

  async edit(p: Product, e: Edit): Promise<Product> {
    const patch: Parameters<Store['update']>[1] = {}
    if (e.name !== undefined) {
      if (!e.name.trim()) throw new InputError('Give it a name', 'name')
      patch.name = clip(e.name, 60)
    }
    if (e.tagline !== undefined) patch.tagline = clip(e.tagline, 90)
    if (e.description !== undefined) patch.description = clip(e.description, 1200)
    if (e.tags !== undefined) patch.tags = [...new Set(list(e.tags).map((t) => t.toLowerCase().replace(/^#/, '').replace(/[^a-z0-9 +#.-]/g, '').slice(0, 24)).filter((t) => t.length >= 2))].slice(0, 6)
    if (e.makerName !== undefined) patch.makerName = clip(e.makerName, 60)
    if (e.videos !== undefined) {
      const videos: Video[] = []
      for (const v of list(e.videos)) {
        const video = videoFrom(v.startsWith('http') ? v : `https://${v}`)
        if (!video) throw new InputError(`Not a YouTube, Vimeo, Loom or .mp4 link: ${v}`, 'videos')
        if (!videos.some((x) => x.url === video.url)) videos.push(video)
      }
      patch.videos = videos.slice(0, 4)
    }
    if (e.socials !== undefined) {
      const socials: Record<string, string> = {}
      for (const [k, v] of Object.entries(e.socials)) if (SOCIAL_KINDS.includes(k) && /^https:\/\/\S+$/.test(String(v ?? '').trim())) socials[k] = String(v).trim().slice(0, 300)
      patch.socials = socials
    }
    if (e.remove !== undefined) {
      const drop = new Set(list(e.remove))
      if (p.logo && drop.has(p.logo)) patch.logo = null
      if (p.ogImage && drop.has(p.ogImage)) patch.ogImage = null
      if (p.screenshot && drop.has(p.screenshot)) patch.screenshot = null
      patch.images = p.images.filter((f) => !drop.has(f))
    }
    let updated = this.store.update(p.id, patch)!
    if (e.makerProfile !== undefined) updated = e.makerProfile.trim() ? await this.setMaker(updated, e.makerProfile, e.makerName) : this.store.update(p.id, { makerProfile: null, makerId: null, makerVerified: false })!
    return updated
  }

  /**
   * The maker is an OpenProfile.md. We read it; it is verified when it names
   * the product (Web or an account on the product's domain) or lives there.
   */
  async setMaker(p: Product, profileUrl: string, name?: string): Promise<Product> {
    let url: URL
    try {
      url = normalizeUrl(profileUrl)
    } catch (e) {
      throw new InputError(`Maker profile: ${(e as Error).message}`, 'makerProfile')
    }
    const r = await safeFetch(url, { ...this.config.fetch, accept: 'text/markdown,text/plain;q=0.9', maxBytes: 256 * 1024, timeoutMs: 8000 }).catch((e) => {
      throw new InputError(`Could not read the maker profile: ${(e as Error).message}`, 'makerProfile')
    })
    const profile = r.status < 300 ? readProfile(new TextDecoder().decode(r.body), r.url.href) : null
    if (!profile) throw new InputError('That is not an OpenProfile.md (logicsrc.com/openprofile): a Markdown file starting with "# Your Name".', 'makerProfile')
    const host = (u: string | null) => {
      try {
        return u ? new URL(u).hostname.replace(/^www\./, '') : ''
      } catch {
        return ''
      }
    }
    const verified = host(r.url.href) === p.domain || host(profile.web) === p.domain || profile.accounts.some((a) => host(a) === p.domain)
    const maker = this.store.upsertMaker({ name: profile.name, profileUrl: r.url.href, headline: profile.headline, avatar: profile.avatar, web: profile.web, accounts: profile.accounts })
    return this.store.update(p.id, { makerProfile: r.url.href, makerId: maker.id, makerVerified: verified, makerName: clip(name?.trim() || profile.name, 60) })!
  }

  /** Has the maker linked back to us from their homepage, or put this listing's badge (any account's id) on it? */
  async verify(p: Product): Promise<boolean> {
    const html = await this.homepage(p)
    const ok = this.linksBack(html) || this.badgeIds(html).some((id) => this.store.badge(id)?.productId === p.id)
    this.store.setVerified(p.id, ok ? Date.now() : null)
    return ok
  }

  /** The product as an OpenSite 0.1 record: what we read, kept so anyone can reuse it. */
  recordFrom(info: SiteInfo): Record<string, unknown> {
    return {
      opensite: '0.1',
      url: info.url,
      canonical: info.canonical,
      site: { name: info.name, web: new URL(info.url).origin },
      kind: info.kind,
      title: info.name,
      description: info.description,
      ...(info.ogImage ? { image: { url: info.ogImage } } : {}),
      language: info.language,
      ...(info.profile ? { author: { name: info.profile.name, profile: info.profile.url } } : {}),
      tags: info.tags,
      feeds: info.feeds,
      published_at: null,
      modified_at: null,
      fetched_at: new Date().toISOString(),
      status: 'live',
      source: info.declared ? 'declared' : 'read',
      cards: info.cards,
      jsonld: info.jsonld,
    }
  }

  /** The product as an OpenProfile.md, Kind organization. */
  openProfile(p: Product): string {
    const logo = p.logo ? `${this.config.origin}/m/${p.id}/${p.logo}` : null
    const accounts = [...Object.values(p.socials), p.llms?.url, this.link(p)].filter(Boolean) as string[]
    return renderOpenProfile(
      makeOpenProfile({
        name: p.name,
        identity: { Kind: 'organization', Web: p.url, Avatar: logo, Handle: p.slug },
        headline: p.tagline || null,
        prose: p.description || null,
        sections: [
          listSection('Accounts', accounts),
          listSection('Topics', p.tags),
          p.makerProfile ? keyedSection('Operator', { Name: p.makerName || null, Profile: p.makerProfile }) : p.makerName ? keyedSection('Operator', { Name: p.makerName }) : null,
          keyedSection('Launch', { Launched: p.launchedAt ? dayOf(p.launchedAt) : null, Votes: p.votes, On: this.link(p) }),
        ],
      }),
    )
  }

  /** A maker as an OpenProfile.md: their own profile's essentials plus what they launched here. */
  makerProfile(makerId: string): string | null {
    const m = this.store.maker(makerId)
    if (!m) return null
    const products = this.store.byMaker(makerId)
    return renderOpenProfile(
      makeOpenProfile({
        name: m.name,
        identity: { Kind: 'person', Web: m.web, Avatar: m.avatar, Profile: m.profileUrl },
        headline: m.headline || null,
        sections: [listSection('Accounts', [m.profileUrl, ...m.accounts]), listSection('Projects', products.map((p) => `[${p.name}](${this.link(p)}): ${p.tagline}`))],
      }),
    )
  }

  /** Start a crypto payment to feature a product; returns where to send the buyer. */
  async feature(p: Product, chain: string, fetcher: typeof fetch = fetch): Promise<{ checkoutUrl: string; ref: string }> {
    const cp = this.config.coinpay
    if (!cp) throw new InputError('Featuring is not set up on this server yet.')
    if (p.status !== 'live') throw new InputError('Publish it first.')
    if (!this.config.chains.includes(chain)) throw new InputError('Pick a currency from the list', 'chain')
    const res = await fetcher(`${cp.baseUrl}/api/payments/create`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cp.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        business_id: cp.businessId,
        amount: this.config.featureUsd,
        currency: 'USD',
        blockchain: chain,
        payment_method: 'crypto',
        description: `built.indie: feature ${p.name} for ${this.config.featureDays} days`,
        metadata: { product_id: p.id, product: 'feature' },
        success_url: `${this.link(p)}?featured=1`,
        cancel_url: this.link(p),
      }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${(await res.text()).slice(0, 200)}`)
    const body = (await res.json()) as any
    const payment = body?.payment ?? body
    const ref = String(payment?.id ?? payment?.payment_id ?? '')
    if (!ref) throw new Error('CoinPay returned no payment reference')
    // Written before the buyer leaves: a webhook can beat the redirect.
    this.store.addPayment({ ref, productId: p.id, amountUsd: this.config.featureUsd, chain, days: this.config.featureDays })
    return { checkoutUrl: `${cp.baseUrl}/pay/${ref}`, ref }
  }

  /** CoinPay's webhook: `t=<unix>,v1=<hmac of "t.body">`; the payload is { data: { payment_id, status } }. */
  webhook(raw: string, header: string | undefined, nowSeconds = Date.now() / 1000): { ok: boolean; status?: number } {
    const cp = this.config.coinpay
    if (!cp?.webhookSecret || !header) return { ok: false, status: 401 }
    const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())))
    const t = Number(parts.t)
    if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > 300) return { ok: false, status: 401 }
    const expected = Buffer.from(createHmac('sha256', cp.webhookSecret).update(`${parts.t}.${raw}`).digest('hex'), 'hex')
    const given = Buffer.from(String(parts.v1), 'hex')
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, status: 401 }
    let payload: any
    try {
      payload = JSON.parse(raw)
    } catch {
      return { ok: false, status: 400 }
    }
    const data = payload?.data ?? payload
    const ref = String(data?.payment_id ?? data?.id ?? '')
    const status = String(data?.status ?? payload?.type?.replace(/^payment\./, '') ?? '').toLowerCase()
    if (!ref || !this.store.payment(ref)) return { ok: true }
    if (SETTLED.has(status)) this.store.settle(ref)
    else if (status) this.store.setPaymentStatus(ref, status)
    return { ok: true }
  }
}

export { makerIdFor }
