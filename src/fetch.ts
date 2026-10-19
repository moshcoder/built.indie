/**
 * Autofetch: everything we can learn about a product from its own homepage.
 *
 * Give it a URL; it reads the page (meta tags, Open Graph, Twitter cards,
 * JSON-LD, icons, the web manifest, <video>/<iframe> embeds, social links,
 * big images) plus /llms.txt, the manifest and the LogicSRC files a site may
 * serve about itself (logicsrc.com/specs): opensite.json (what it is),
 * openprofile.md (who runs it), openstack.md (what it is built on),
 * opensaas.json (its plans and the way out) and openicon.json (its icon set).
 * Then it picks a name, a tagline,
 * a description, a logo, screenshots and videos. Nothing is stored here: the
 * caller decides what to download (see media.ts).
 *
 * Every fetch goes through safeFetch: http(s) only, public addresses only
 * (checked on every redirect hop), a timeout and a byte cap.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { accounts, identityValue, kindOf as kindOfProfile, parseOpenProfile, web } from '@profullstack/openprofile'
import { tagsFor } from './tags.js'

export type Video = { kind: 'youtube' | 'vimeo' | 'loom' | 'file'; url: string; embed: string | null }

export type SiteInfo = {
  url: string
  domain: string
  name: string
  tagline: string
  description: string
  logo: string | null
  ogImage: string | null
  images: string[]
  videos: Video[]
  socials: Record<string, string>
  tags: string[]
  themeColor: string | null
  llms: { url: string; title: string; summary: string } | null
  manifest: boolean
  /** The company or person behind it, from their OpenProfile.md (logicsrc.com/docs/openprofile). */
  profile: Profile | null
  /** OpenSite reading (logicsrc.com/docs/opensite): kept so we can publish the record. */
  canonical: string
  kind: string
  language: string | null
  feeds: string[]
  cards: Record<string, Record<string, string>>
  jsonld: unknown[]
  declared: boolean
  /** OpenStack.md (logicsrc.com/docs/openstack): what it is built on. */
  stack: Stack | null
  /** OpenSaaS (logicsrc.com/docs/opensaas): its plans, and where to cancel. */
  pricing: Pricing | null
  /** OpenIcon (logicsrc.com/docs/openicon): the icon set it publishes. */
  openicon: string | null
  sources: string[]
}

export type Stack = { url: string; items: { layer: string; name: string }[] }
export type Pricing = { url: string; currency: string; plans: { name: string; price: number | null; period: string | null; trial: string | null; url: string | null }[]; cancel: string | null }

export type Profile = { url: string; kind: 'person' | 'agent' | 'organization' | null; name: string; headline: string; avatar: string | null; web: string | null; accounts: string[] }

export class FetchError extends Error {}

const UA = 'Mozilla/5.0 (compatible; built.indie/1.0; +https://built.indie.pit.world/help#bot)'

/** Loopback, private, link-local, CGNAT, multicast, reserved: never fetched. */
export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  }
  const v6 = ip.toLowerCase()
  if (v6.startsWith('::ffff:')) return privateAddress(v6.slice(7))
  return v6 === '::' || v6 === '::1' || /^f[cd]/.test(v6) || /^fe[89ab]/.test(v6) || v6.startsWith('ff') || v6.startsWith('64:ff9b') || v6.startsWith('2001:db8')
}

/** A product URL as typed: adds https://, drops the fragment, refuses anything that is not a public web address. */
export function normalizeUrl(input: string): URL {
  let raw = String(input ?? '').trim()
  if (!raw) throw new FetchError('Paste your product’s URL')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new FetchError('That is not a URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('Only http and https URLs')
  if (url.username || url.password) throw new FetchError('No passwords in the URL')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host.includes('.') && !isIP(host)) throw new FetchError('That address is not on the public internet')
  if (host.endsWith('.local') || host.endsWith('.internal') || host === 'localhost' || (isIP(host) && privateAddress(host))) throw new FetchError('That address is not on the public internet')
  url.hash = ''
  return url
}

type Resolve = (host: string) => Promise<string[]>
const dnsResolve: Resolve = async (host) => (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

export type FetchOptions = { fetch?: typeof fetch; resolve?: Resolve; timeoutMs?: number; maxBytes?: number; accept?: string }

/** GET a public URL, following up to 5 redirects by hand so every hop is checked. */
export async function safeFetch(input: string | URL, o: FetchOptions = {}): Promise<{ url: URL; status: number; type: string; body: Uint8Array }> {
  const doFetch = o.fetch ?? fetch
  const resolve = o.resolve ?? dnsResolve
  const maxBytes = o.maxBytes ?? 3 * 1024 * 1024
  const deadline = AbortSignal.timeout(o.timeoutMs ?? 12_000)
  let url = normalizeUrl(String(input))
  for (let hop = 0; hop < 6; hop++) {
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const addresses = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[])
    if (!addresses.length) throw new FetchError(`${host} does not resolve`)
    if (addresses.some(privateAddress)) throw new FetchError(`${host} is not on the public internet`)
    const res = await doFetch(url, { redirect: 'manual', signal: deadline, headers: { 'user-agent': UA, accept: o.accept ?? '*/*', 'accept-language': 'en' } })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => {})
      url = normalizeUrl(new URL(res.headers.get('location')!, url).href)
      continue
    }
    const reader = res.body?.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    while (reader) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new FetchError(`${url.hostname} sent more than ${Math.round(maxBytes / 1024 / 1024)} MB`)
      }
      chunks.push(value)
    }
    const body = new Uint8Array(size)
    let at = 0
    for (const c of chunks) body.set(c, at), (at += c.byteLength)
    return { url, status: res.status, type: (res.headers.get('content-type') ?? '').toLowerCase(), body }
  }
  throw new FetchError('Too many redirects')
}

const SOCIALS: [string, RegExp][] = [
  ['x', /^https?:\/\/(www\.)?(x|twitter)\.com\/(?!intent|share|home|search|hashtag|i\/)[A-Za-z0-9_]{1,15}\/?$/],
  ['github', /^https?:\/\/(www\.)?github\.com\/(?!sponsors|features|about|pricing|login|signup)[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)?\/?$/],
  ['linkedin', /^https?:\/\/([a-z]+\.)?linkedin\.com\/(company|in)\/[^/?#]+\/?$/],
  ['discord', /^https?:\/\/(www\.)?(discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]+\/?$/],
  ['youtube', /^https?:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)[^/?#]+\/?$/],
  ['bluesky', /^https?:\/\/bsky\.app\/profile\/[^/?#]+\/?$/],
  ['instagram', /^https?:\/\/(www\.)?instagram\.com\/[A-Za-z0-9_.]+\/?$/],
  ['tiktok', /^https?:\/\/(www\.)?tiktok\.com\/@[A-Za-z0-9_.]+\/?$/],
  ['reddit', /^https?:\/\/(www\.)?reddit\.com\/r\/[A-Za-z0-9_]+\/?$/],
  ['telegram', /^https?:\/\/(t\.me|telegram\.me)\/[A-Za-z0-9_]+\/?$/],
  ['producthunt', /^https?:\/\/(www\.)?producthunt\.com\/(products|posts)\/[^/?#]+\/?$/],
  ['appstore', /^https?:\/\/apps\.apple\.com\/[^?#]+\/id\d+/],
  ['playstore', /^https?:\/\/play\.google\.com\/store\/apps\/details\?id=[A-Za-z0-9_.]+/],
  ['chrome', /^https?:\/\/chrome(webstore)?\.google\.com\/(webstore\/)?detail\//],
]

export const SOCIAL_KINDS = SOCIALS.map(([k]) => k)

/** A YouTube, Vimeo or Loom link or embed, as a privacy-friendly embed URL; or a direct video file. */
export function videoFrom(raw: string): Video | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^www\.|^m\./, '')
  let id: string | null = null
  if (host === 'youtu.be') id = u.pathname.slice(1)
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') id = u.searchParams.get('v') ?? u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/)?.[1] ?? null
  if (id && /^[A-Za-z0-9_-]{6,20}$/.test(id)) return { kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, embed: `https://www.youtube-nocookie.com/embed/${id}` }
  if (host === 'vimeo.com' || host === 'player.vimeo.com') {
    const v = u.pathname.match(/(\d{5,})/)?.[1]
    if (v) return { kind: 'vimeo', url: `https://vimeo.com/${v}`, embed: `https://player.vimeo.com/video/${v}` }
  }
  if (host === 'loom.com') {
    const v = u.pathname.match(/^\/(?:share|embed)\/([a-f0-9]{20,})/)?.[1]
    if (v) return { kind: 'loom', url: `https://www.loom.com/share/${v}`, embed: `https://www.loom.com/embed/${v}` }
  }
  if (/\.(mp4|webm|mov)$/i.test(u.pathname)) return { kind: 'file', url: u.href, embed: null }
  return null
}

export const decode = (s: string) =>
  s
    .replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp|#39);/gi, (m, e: string) => {
      const k = e.toLowerCase()
      if (k === 'amp') return '&'
      if (k === 'lt') return '<'
      if (k === 'gt') return '>'
      if (k === 'quot') return '"'
      if (k === 'apos' || k === '#39') return "'"
      if (k === 'nbsp') return ' '
      const n = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m
    })
    .replace(/\s+/g, ' ')
    .trim()

export const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  if (t.length <= n) return t
  const cut = t.slice(0, n - 1)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(n * 0.6)))}…`
}

type Icon = { href: string; size: number; rel: string }

/** What the homepage's HTML says, before any choosing. */
export type PageFacts = {
  meta: Record<string, string>
  title: string
  h1: string
  icons: Icon[]
  manifest: string | null
  jsonld: unknown[]
  links: string[]
  images: { src: string; width: number; hint: string }[]
  videos: string[]
  firstParagraph: string
  canonical: string | null
  lang: string | null
  feeds: string[]
  profileLinks: string[]
  /** <link rel="opensaas|openstack|openicon">, by rel. */
  specLinks: Record<string, string>
}

export async function readPage(html: string, base: URL): Promise<PageFacts> {
  const f: PageFacts = { meta: {}, title: '', h1: '', icons: [], manifest: null, jsonld: [], links: [], images: [], videos: [], firstParagraph: '', canonical: null, lang: null, feeds: [], profileLinks: [], specLinks: {} }
  const abs = (v: string | null | undefined) => {
    if (!v) return null
    try {
      const u = new URL(decode(v), base)
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
    } catch {
      return null
    }
  }
  let inTitle = false
  let inH1 = false
  let h1Done = false
  let inP = false
  let ld: string | null = null
  let p = ''
  await new HTMLRewriter()
    .on('html', {
      element(e) {
        f.lang ??= e.getAttribute('lang')?.trim() || null
      },
    })
    .on('meta', {
      element(e) {
        const key = (e.getAttribute('property') ?? e.getAttribute('name') ?? e.getAttribute('itemprop') ?? '').toLowerCase().trim()
        const value = e.getAttribute('content')
        if (key && value && !(key in f.meta)) f.meta[key] = decode(value)
      },
    })
    .on('title', {
      element(e) {
        if (f.title) return
        inTitle = true
        e.onEndTag(() => void (inTitle = false))
      },
      text(t) {
        if (inTitle) f.title += t.text
      },
    })
    .on('h1', {
      element(e) {
        if (h1Done) return
        inH1 = true
        e.onEndTag(() => {
          inH1 = false
          h1Done = Boolean(decode(f.h1))
        })
      },
      text(t) {
        if (inH1) f.h1 += t.text
      },
    })
    .on('h1 br, h1 div, h1 span, h1 p', {
      element() {
        if (inH1) f.h1 += ' '
      },
    })
    .on('p', {
      element(e) {
        if (f.firstParagraph) return
        inP = true
        p = ''
        e.onEndTag(() => {
          inP = false
          if (!f.firstParagraph && decode(p).length >= 60) f.firstParagraph = decode(p)
        })
      },
      text(t) {
        if (inP) p += t.text
      },
    })
    .on('link', {
      element(e) {
        const rel = (e.getAttribute('rel') ?? '').toLowerCase()
        const href = abs(e.getAttribute('href'))
        if (!href) return
        const rels = rel.split(/\s+/)
        if (rels.includes('manifest')) f.manifest ??= href
        if (rels.includes('canonical')) f.canonical ??= href
        if (rels.includes('openprofile') || ((rels.includes('me') || rels.includes('author')) && /openprofile\.md(\?|$)/i.test(href))) f.profileLinks.push(href)
        for (const r of ['opensaas', 'openstack', 'openicon', 'opensite']) if (rels.includes(r)) f.specLinks[r] ??= href
        if (rels.includes('alternate') && /(rss|atom|feed\+json)/i.test(e.getAttribute('type') ?? '')) f.feeds.push(href)
        if (/(^|\s)(icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon)(\s|$)/.test(rel)) {
          const size = Math.max(0, ...(e.getAttribute('sizes') ?? '').split(/\s+/).map((s) => (s === 'any' ? 512 : Number(s.split('x')[0]) || 0)))
          f.icons.push({ href, rel, size: size || (rel.includes('apple') ? 180 : 0) })
        }
      },
    })
    .on('script', {
      element(e) {
        if ((e.getAttribute('type') ?? '').toLowerCase() !== 'application/ld+json') return
        ld = ''
        e.onEndTag(() => {
          try {
            const doc = JSON.parse(ld ?? '')
            for (const d of [doc, ...(Array.isArray(doc) ? doc : []), ...(Array.isArray(doc?.['@graph']) ? doc['@graph'] : [])]) if (d && typeof d === 'object' && !Array.isArray(d)) f.jsonld.push(d)
          } catch {}
          ld = null
        })
      },
      text(t) {
        if (ld !== null) ld += t.text
      },
    })
    .on('a', {
      element(e) {
        const href = abs(e.getAttribute('href'))
        if (href && f.links.length < 400) f.links.push(href)
      },
    })
    .on('img', {
      element(e) {
        const src = abs(e.getAttribute('src') ?? e.getAttribute('data-src') ?? (e.getAttribute('srcset') ?? '').split(',').pop()?.trim().split(/\s+/)[0])
        if (!src || f.images.length >= 60) return
        const hint = `${e.getAttribute('alt') ?? ''} ${e.getAttribute('class') ?? ''} ${e.getAttribute('id') ?? ''} ${src}`.toLowerCase()
        f.images.push({ src, width: Number(e.getAttribute('width')) || 0, hint })
      },
    })
    .on('iframe', {
      element(e) {
        const src = abs(e.getAttribute('src') ?? e.getAttribute('data-src'))
        if (src) f.videos.push(src)
      },
    })
    .on('video', {
      element(e) {
        const src = abs(e.getAttribute('src'))
        if (src) f.videos.push(src)
        const poster = abs(e.getAttribute('poster'))
        if (poster) f.images.push({ src: poster, width: 1280, hint: 'video poster' })
      },
    })
    .on('video source', {
      element(e) {
        const src = abs(e.getAttribute('src'))
        if (src) f.videos.push(src)
      },
    })
    .transform(new Response(html))
    .text()
  f.title = decode(f.title)
  f.h1 = decode(f.h1)
  return f
}

const SEPARATORS = /\s+[|–—·•:-]\s+/

/** "Acme — Invoices that pay themselves" → ["Acme", "Invoices that pay themselves"] */
export function splitTitle(title: string): [string, string] {
  const parts = title.split(SEPARATORS).map((s) => s.trim()).filter(Boolean)
  if (parts.length < 2) return [title.trim(), '']
  // The shorter end is usually the brand.
  const [first, last] = [parts[0]!, parts[parts.length - 1]!]
  return first.length <= last.length ? [first, parts.slice(1).join(' – ')] : [last, parts.slice(0, -1).join(' – ')]
}

/** llms.txt (llmstxt.org): "# Name", then "> one-line summary", then prose. */
export function readLlms(text: string): { title: string; summary: string } | null {
  if (/^\s*<(!doctype|html|head|body)/i.test(text)) return null
  const lines = text.split(/\r?\n/)
  const title = lines.find((l) => /^#\s+\S/.test(l))?.replace(/^#\s+/, '').trim() ?? ''
  const quote = lines.filter((l) => /^>\s?/.test(l)).map((l) => l.replace(/^>\s?/, '')).join(' ').trim()
  const prose = lines.find((l) => l.trim() && !/^[#>\-*[!|`]/.test(l.trim()))?.trim() ?? ''
  if (!title && !quote) return null
  return { title: clip(title, 80), summary: clip(quote || prose, 400) }
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v == null ? [] : [v])
const ldUrl = (v: unknown): string | null => {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') return ldUrl((v as any).url ?? (v as any).contentUrl ?? (v as any)['@id'])
  return null
}

const BAD_IMAGE = /(sprite|pixel|tracking|spacer|badge|avatar|gravatar|emoji|icon|logo|favicon|\.svg(\?|$)|1x1|analytics|doubleclick|facebook\.com\/tr|^data:)/
const GOOD_IMAGE = /screenshot|hero|preview|demo|product|dashboard|poster|showcase|app-?shot|mockup/

/** Read a product's homepage (and its llms.txt + manifest) into a SiteInfo. */
export async function autofetch(input: string, o: FetchOptions = {}): Promise<SiteInfo> {
  const start = normalizeUrl(input)
  const page = await safeFetch(start, { ...o, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5' }).catch((e) => {
    throw e instanceof FetchError ? e : new FetchError(`Could not reach ${start.hostname}: ${e instanceof Error ? e.message : e}`)
  })
  if (page.status >= 400) throw new FetchError(`${page.url.hostname} answered ${page.status}`)
  if (page.type && !page.type.includes('html')) throw new FetchError(`${page.url.hostname} sent ${page.type.split(';')[0]}, not a web page`)
  const base = page.url
  const facts = await readPage(new TextDecoder().decode(page.body), base)
  const m = facts.meta
  const sources = ['homepage']

  // Side files, in parallel; any of them may be missing.
  const side = (url: URL | string, accept: string) =>
    safeFetch(url, { ...o, accept, maxBytes: 512 * 1024, timeoutMs: 6000 })
      .then((r) => (r.status < 300 ? new TextDecoder().decode(r.body) : null))
      .catch(() => null)
  const json = (text: string | null) => {
    try {
      const v = text ? JSON.parse(text) : null
      return v && typeof v === 'object' && !Array.isArray(v) ? v : null
    } catch {
      return null
    }
  }
  const profileUrl = facts.profileLinks[0] ?? new URL('/.well-known/openprofile.md', base.origin).href
  const wellKnown = (name: string, rel: string) => facts.specLinks[rel] ?? new URL(`/.well-known/${name}`, base.origin).href
  const stackUrl = wellKnown('openstack.md', 'openstack')
  const saasUrl = wellKnown('opensaas.json', 'opensaas')
  const iconUrl = wellKnown('openicon.json', 'openicon')
  const [llmsText, manifestText, descriptorText, profileText, robotsText, stackText, saasText, iconText] = await Promise.all([
    side(new URL('/llms.txt', base.origin), 'text/plain,text/markdown;q=0.9,*/*;q=0.1'),
    facts.manifest ? side(facts.manifest, 'application/manifest+json,application/json') : null,
    side(wellKnown('opensite.json', 'opensite'), 'application/json'),
    side(profileUrl, 'text/markdown,text/plain;q=0.9'),
    side(new URL('/robots.txt', base.origin), 'text/plain'),
    side(stackUrl, 'text/markdown,text/plain;q=0.9'),
    side(saasUrl, 'application/json'),
    side(iconUrl, 'application/json'),
  ])

  // OpenSite: a site may say no to readers, by robots.txt or its descriptor.
  const descriptor = json(descriptorText)
  if (descriptor?.index?.allow === false) throw new FetchError(`${base.hostname} asks not to be indexed (opensite.json index.allow is false)`)
  if (robotsText && robotsBlocks(robotsText, base.pathname)) throw new FetchError(`${base.hostname}’s robots.txt asks readers like us to stay out`)
  const declared: any = descriptor?.site && typeof descriptor.site === 'object' ? descriptor.site : null
  if (declared) sources.push('opensite.json')

  const llms = llmsText ? readLlms(llmsText) : null
  if (llms) sources.push('llms.txt')
  const manifest: any = json(manifestText)
  if (manifest) sources.push('manifest')
  const profile = profileText ? readProfile(profileText, profileUrl) : null
  if (profile) sources.push('openprofile.md')
  const stack = stackText ? readStack(stackText, stackUrl) : null
  if (stack) sources.push('openstack.md')
  const pricing = readSaas(json(saasText), saasUrl)
  if (pricing) sources.push('opensaas.json')
  const openicon = json(iconText)?.openicon ? iconUrl : null
  if (openicon) sources.push('openicon.json')

  const ld = facts.jsonld as any[]
  if (ld.length) sources.push('json-ld')
  const ldOf = (...types: string[]) => ld.find((d) => asArray(d['@type']).some((t) => types.includes(String(t))))
  const app = ldOf('SoftwareApplication', 'WebApplication', 'MobileApplication', 'Product', 'VideoGame') ?? null
  const org = ldOf('Organization', 'Corporation', 'LocalBusiness') ?? null
  const site = ldOf('WebSite') ?? null
  if (m['og:title'] || m['og:image']) sources.push('open graph')
  if (m['twitter:card']) sources.push('twitter card')

  const str = (v: unknown) => (typeof v === 'string' ? decode(v) : '')
  const [titleName, titleRest] = splitTitle(str(m['og:title']) || facts.title)
  const name = clip(
    // A manifest's short_name is a home-screen label ("Family" for family.ancestry): last resort.
    [declared?.name, m['og:site_name'], app?.name, m['application-name'], manifest?.name, site?.name, org?.name, llms?.title, titleName, manifest?.short_name].map(str).find((v) => v && v.length <= 40) ??
      base.hostname.replace(/^www\./, ''),
    60,
  )

  const description = [declared?.description, llms?.summary, m['description'], m['og:description'], m['twitter:description'], app?.description, manifest?.description, facts.firstParagraph].map(str).find((v) => v.length >= 20) ?? ''

  const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const firstSentence = (s: string) => s.split(/(?<=[.!?])\s/)[0] ?? s
  const tagline = clip([titleRest, facts.h1, firstSentence(str(m['description'])), firstSentence(description)].map(str).find((v) => v.length >= 8 && flat(v) !== flat(name)) ?? '', 90)

  const absolute = (v: unknown, from: URL = base) => {
    const s = ldUrl(v)
    if (!s) return null
    try {
      const u = new URL(s, from)
      return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null
    } catch {
      return null
    }
  }

  // Logo: something square and big. JSON-LD logo, apple-touch-icon, manifest icon, any icon, /favicon.ico.
  const manifestBase = facts.manifest ? new URL(facts.manifest) : base
  const manifestIcons: Icon[] = asArray(manifest?.icons)
    .map((i: any) => ({ href: absolute(i?.src, manifestBase) ?? '', size: Math.max(0, ...String(i?.sizes ?? '').split(/\s+/).map((s) => Number(s.split('x')[0]) || 0)), rel: 'manifest' }))
    .filter((i) => i.href)
  const icons = [...facts.icons, ...manifestIcons].filter((i) => !i.rel.includes('mask')).sort((a, b) => b.size - a.size)
  const logo = absolute(declared?.icon) ?? absolute(org?.logo) ?? absolute(app?.logo) ?? icons.find((i) => i.size >= 96)?.href ?? icons[0]?.href ?? (profile?.kind === 'organization' ? profile.avatar : null) ?? new URL('/favicon.ico', base).href

  const ogImage = absolute(declared?.image) ?? absolute(m['og:image:secure_url'] ?? m['og:image'] ?? m['og:image:url'] ?? m['twitter:image'] ?? m['twitter:image:src'] ?? asArray(app?.image)[0])

  // Screenshots: JSON-LD screenshots first, then big content images from the page.
  const seen = new Set([logo, ogImage].filter(Boolean) as string[])
  const images: string[] = []
  const add = (src: string | null) => {
    if (!src || seen.has(src) || images.length >= 6) return
    seen.add(src)
    images.push(src)
  }
  for (const s of asArray(app?.screenshot)) add(absolute(s))
  for (const s of asArray(app?.image).slice(1)) add(absolute(s))
  facts.images
    .filter((i) => GOOD_IMAGE.test(i.hint) || !BAD_IMAGE.test(i.hint))
    .map((i) => ({ ...i, score: (GOOD_IMAGE.test(i.hint) ? 2 : 0) + (i.width >= 600 ? 2 : i.width >= 300 ? 1 : i.width === 0 ? 0.5 : -3) }))
    .filter((i) => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .forEach((i) => add(i.src))

  // Videos: og:video, JSON-LD VideoObject, embeds on the page, links to them.
  const videos: Video[] = []
  const addVideo = (raw: string | null) => {
    const v = raw ? videoFrom(raw) : null
    if (v && !videos.some((x) => x.url === v.url) && videos.length < 4) videos.push(v)
  }
  addVideo(absolute(m['og:video:secure_url'] ?? m['og:video'] ?? m['og:video:url'] ?? m['twitter:player']))
  for (const d of ld) if (asArray(d['@type']).includes('VideoObject')) addVideo(absolute(d.embedUrl) ?? absolute(d.contentUrl))
  for (const v of asArray(app?.video)) addVideo(absolute((v as any)?.embedUrl) ?? absolute(v))
  for (const v of facts.videos) addVideo(v)
  for (const l of facts.links) if (/youtu\.?be|vimeo\.com|loom\.com\/share/.test(l)) addVideo(l)

  // Socials: sameAs, twitter:site, and links on the page.
  const socials: Record<string, string> = {}
  const addSocial = (raw: string | null) => {
    if (!raw) return
    for (const [kind, re] of SOCIALS) if (!socials[kind] && re.test(raw)) socials[kind] = raw.replace(/\/+$/, '')
  }
  for (const s of [...asArray(org?.sameAs), ...asArray(app?.sameAs), ...asArray(site?.sameAs)]) addSocial(absolute(s))
  const handle = (m['twitter:site'] ?? m['twitter:creator'] ?? '').replace(/^@/, '')
  if (/^[A-Za-z0-9_]{1,15}$/.test(handle)) socials.x ??= `https://x.com/${handle}`
  for (const a of profile?.accounts ?? []) addSocial(a)
  for (const l of facts.links) addSocial(l)

  // Tags: what the site declares (opensite.json, keywords meta, article:tag, JSON-LD keywords,
  // category and genre, manifest categories); else topics read from its own words.
  const words = (v: unknown) => asArray(v).flatMap((k) => String(k ?? '').split(','))
  const tags = tagsFor(
    [
      ...words(declared?.tags),
      ...words(declared?.keywords),
      ...words(m['keywords']),
      ...words(m['article:tag']),
      ...[app, org, site].flatMap((d) => [...words(d?.keywords), ...words(d?.applicationCategory), ...words(d?.genre)]),
      ...words(manifest?.categories),
    ],
    { name, tagline, description },
  )

  return {
    url: base.href,
    domain: base.hostname.replace(/^www\./, ''),
    name,
    tagline,
    description: clip(description, 1200),
    logo,
    ogImage,
    images,
    videos,
    socials,
    tags,
    themeColor: /^#[0-9a-f]{3,8}$/i.test(m['theme-color'] ?? '') ? m['theme-color']! : null,
    llms: llms ? { url: new URL('/llms.txt', base.origin).href, ...llms } : null,
    manifest: Boolean(manifest),
    profile,
    canonical: facts.canonical ?? absolute(m['og:url']) ?? base.href,
    kind: kindOf(ld, m['og:type']),
    language: facts.lang ?? m['og:locale'] ?? null,
    feeds: [...new Set([...facts.feeds, ...asArray(declared?.feeds).map(String)])].slice(0, 5),
    cards: cardsOf(m),
    jsonld: ld.slice(0, 20),
    declared: Boolean(declared),
    stack,
    pricing,
    openicon,
    sources,
  }
}

/** OpenStack.md: every bullet under a `##` (or `###` interface) heading is one item; we keep its name, not its notes. */
export function readStack(text: string, url: string): Stack | null {
  if (/^\s*<(!doctype|html|head|body)/i.test(text) || !/^#\s+\S/m.test(text)) return null
  const items: Stack['items'] = []
  let layer = ''
  let inIdentity = true
  for (const line of text.split(/\r?\n/)) {
    const h = line.match(/^(#{2,3})\s+(.+)$/)
    if (h) {
      inIdentity = false
      layer = h[1] === '##' ? h[2]!.trim() : `${layer.split(' / ')[0]} / ${h[2]!.trim()}`
      continue
    }
    const b = line.match(/^\s*[-*]\s+(.+)$/)
    if (!b || inIdentity || !layer || /^(rules|never|avoid|not)\b/i.test(layer)) continue
    const name = b[1]!.replace(/\*\*/g, '').replace(/`/g, '').split(/:\s|\s[—–]\s|\s\(/)[0]!.trim()
    if (name && name.length <= 60 && items.length < 60 && !items.some((i) => i.name === name)) items.push({ layer: clip(layer, 40), name })
  }
  return items.length ? { url, items } : null
}

/** OpenSaaS: the plans a person can buy, and the page that cancels them. */
export function readSaas(doc: any, url: string): Pricing | null {
  if (!doc || !Array.isArray(doc.plans)) return null
  const link = (v: unknown) => (typeof v === 'string' && /^https?:\/\//.test(v) ? v : null)
  const plans = doc.plans
    .filter((p: any) => p && typeof p.name === 'string' && (p.status ?? 'active') === 'active')
    .slice(0, 8)
    .map((p: any) => ({ name: clip(String(p.name), 40), price: typeof p.price === 'number' ? p.price : null, period: typeof p.period === 'string' ? p.period.slice(0, 12) : null, trial: typeof p.trial === 'string' ? p.trial.slice(0, 20) : null, url: link(p.url) }))
  if (!plans.length) return null
  return { url, currency: typeof doc.service?.currency === 'string' ? doc.service.currency.slice(0, 3).toUpperCase() : 'USD', plans, cancel: link(doc.actions?.cancel?.page) }
}

/** OpenSite step 7: the record's kind from JSON-LD @type, else og:type. A product directory mostly sees 'product' and 'site'. */
export function kindOf(ld: any[], ogType: string | undefined): string {
  const types = ld.flatMap((d) => asArray(d['@type']).map(String))
  const map: [string[], string][] = [
    [['SoftwareApplication', 'WebApplication', 'MobileApplication', 'Product', 'VideoGame'], 'product'],
    [['Article', 'NewsArticle', 'BlogPosting'], 'article'],
    [['Person'], 'profile'],
    [['Event'], 'event'],
    [['VideoObject'], 'video'],
    [['PodcastSeries'], 'podcast'],
    [['WebSite'], 'site'],
  ]
  for (const [names, kind] of map) if (types.some((t) => names.includes(t))) return kind
  const og = String(ogType ?? '').toLowerCase()
  if (['article', 'profile', 'product'].includes(og)) return og
  if (og.startsWith('video')) return 'video'
  return og === 'website' ? 'site' : 'page'
}

/** OpenSite step 12: card tags verbatim, grouped by prefix. */
function cardsOf(meta: Record<string, string>): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const [k, v] of Object.entries(meta)) {
    const at = k.indexOf(':')
    if (at < 1) continue
    const prefix = k.slice(0, at)
    if (!/^[a-z]+$/.test(prefix) || Object.keys(out).length > 12) continue
    ;(out[prefix] ??= {})[k.slice(at + 1)] = v.slice(0, 500)
  }
  return out
}

/** robots.txt: does the group for us (or *) disallow this path? Longest match wins; Allow beats Disallow on a tie. */
export function robotsBlocks(text: string, path: string, agents = ['built.indie', 'opensite']): boolean {
  const groups: { agents: string[]; rules: [boolean, string][] }[] = []
  let current: (typeof groups)[number] | null = null
  let lastWasAgent = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const [, key, value] = m as unknown as [string, string, string]
    if (key.toLowerCase() === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }))
      current.agents.push(value.toLowerCase())
      lastWasAgent = true
    } else {
      lastWasAgent = false
      if (current && /^(allow|disallow)$/i.test(key)) current.rules.push([key.toLowerCase() === 'allow', value])
    }
  }
  const mine = groups.find((g) => g.agents.some((a) => agents.some((x) => a !== '*' && x.startsWith(a)))) ?? groups.find((g) => g.agents.includes('*'))
  let best: [boolean, number] = [true, -1]
  for (const [allow, rule] of mine?.rules ?? []) {
    if (!rule) continue
    const re = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')}`)
    if (re.test(path) && (rule.length > best[1] || (rule.length === best[1] && allow))) best = [allow, rule.length]
  }
  return !best[0]
}

/** The essentials of an OpenProfile.md: who, what kind, their picture and accounts. */
export function readProfile(text: string, url: string): Profile | null {
  if (/^\s*<(!doctype|html|head|body)/i.test(text) || !/^#\s+\S/m.test(text)) return null
  try {
    const doc = parseOpenProfile(text)
    if (!doc.name) return null
    const avatar = identityValue(doc, 'Avatar')
    return {
      url,
      kind: kindOfProfile(doc),
      name: clip(doc.name, 80),
      headline: clip(doc.headline ?? '', 160),
      avatar: avatar && /^https?:\/\//.test(avatar) ? avatar : null,
      web: web(doc),
      accounts: accounts(doc).map((a) => a.url).filter((u) => /^https?:\/\//.test(u)).slice(0, 20),
    }
  } catch {
    return null
  }
}
