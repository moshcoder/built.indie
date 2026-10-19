import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth, type Mail } from '../src/auth.ts'
import { main, parseArgs } from '../src/cli.ts'
import { BuiltIndieClient } from '../src/client.ts'
import { Store, slugify } from '../src/db.ts'
import { autofetch, normalizeUrl, privateAddress, readLlms, robotsBlocks, splitTitle, videoFrom } from '../src/fetch.ts'
import { dimensions, Media, sniff } from '../src/media.ts'
import { clientIp, createApp } from '../src/server.ts'
import { BuiltIndie, CLAIM_PREFIX, publicTxt } from '../src/service.ts'
import { initialState, onKey } from '../src/tui.ts'
import { glyph, icon } from '../src/icons.ts'
import { cleanTags, inferTags, normalizeTag, tagsFor } from '../src/tags.ts'

const PNG = (w: number, h: number) => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, w)
  new DataView(b.buffer).setUint32(20, h)
  return b
}

const HOME = `<!doctype html><html lang="en"><head>
<title>Acme — Invoices that pay themselves</title>
<meta name="description" content="Acme sends invoices and chases them for you. Built for freelancers.">
<meta property="og:image" content="/og.png">
<meta property="og:type" content="website">
<meta name="twitter:site" content="@acmehq">
<meta name="keywords" content="invoicing, freelancers">
<meta name="theme-color" content="#123456">
<link rel="apple-touch-icon" href="/apple.png">
<link rel="manifest" href="/manifest.json">
<link rel="canonical" href="https://acme.test/">
<link rel="alternate" type="application/rss+xml" href="/blog.xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SoftwareApplication","name":"Acme","applicationCategory":"BusinessApplication","screenshot":"/shot.png","sameAs":["https://github.com/acme"]}</script>
</head><body><h1>Invoices that<br>pay themselves</h1>
<p>Acme is the invoicing tool that chases late payers so you never have to write that awkward email again.</p>
<img src="/hero.png" width="1200" alt="Acme dashboard screenshot"><img src="/tiny-icon.png" width="16">
<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
<a href="https://x.com/acmehq">X</a><a href="https://discord.gg/acme">Discord</a><a href="https://x.com/intent/tweet">share</a>
</body></html>`

const PROFILE = `# Acme Inc\n\n- **Kind**: organization\n- **Web**: https://acme.test\n- **Avatar**: https://acme.test/apple.png\n\nInvoices that pay themselves.\n\n## Accounts\n\n- https://www.linkedin.com/company/acme\n`
const MAKER = `# Ada Lovelace\n\n- **Kind**: person\n- **Web**: https://ada.test\n\nI make invoicing tools.\n\n## Accounts\n\n- https://acme.test\n- https://github.com/ada\n`

/** A small web: acme.test with every source we read, ada.test with a maker profile. */
function fakeWeb(overrides: Record<string, Response | (() => Response)> = {}) {
  const hits: string[] = []
  const pages: Record<string, () => Response> = {
    'https://acme.test/': () => new Response(HOME, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    'https://acme.test/llms.txt': () => new Response('# Acme\n\n> Invoicing that chases late payers for you.\n\nMore here.'),
    'https://acme.test/manifest.json': () => Response.json({ name: 'Acme Invoicing', icons: [{ src: '/icon-512.png', sizes: '512x512' }], categories: ['finance'] }),
    'https://acme.test/.well-known/openprofile.md': () => new Response(PROFILE),
    'https://acme.test/robots.txt': () => new Response('User-agent: *\nDisallow: /private\n'),
    'https://acme.test/og.png': () => new Response(PNG(1200, 630)),
    'https://acme.test/apple.png': () => new Response(PNG(180, 180)),
    'https://acme.test/icon-512.png': () => new Response(PNG(512, 512)),
    'https://acme.test/shot.png': () => new Response(PNG(1280, 800)),
    'https://acme.test/hero.png': () => new Response(PNG(1200, 700)),
    'https://ada.test/openprofile.md': () => new Response(MAKER),
    'https://acme.test/.well-known/openstack.md': () => new Response('# Acme\n\n- **Kind**: product\n\nInvoices.\n\n## Languages\n\n- TypeScript 5.9: everything\n\n## Interfaces\n\n### Web\n\n- Next.js 16 (App Router): the app\n\n## Data\n\n- Postgres 17: invoices\n\n## Never\n\n- Stripe\n'),
    'https://acme.test/.well-known/opensaas.json': () => Response.json({ service: { name: 'Acme', currency: 'USD' }, plans: [{ name: 'Free', price: 0, status: 'active' }, { name: 'Pro', price: 12, period: 'month', trial: '14 days', url: 'https://acme.test/pro' }, { name: 'Old', price: 5, status: 'retired' }], actions: { cancel: { page: 'https://acme.test/billing' } } }),
    'https://acme.test/.well-known/openicon.json': () => Response.json({ openicon: '0.1', name: 'Acme icons', icons: [] }),
  }
  for (const [k, v] of Object.entries(overrides)) pages[k] = typeof v === 'function' ? v : () => v
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input)
    hits.push(url)
    return pages[url]?.() ?? new Response('not found', { status: 404 })
  }) as unknown as typeof fetch
  return { fetch: fetchImpl, resolve: async () => ['93.184.216.34'], hits }
}

function setup(web = fakeWeb(), txt: Record<string, string[][]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'builtindie-test-'))
  const store = new Store(join(dir, 'test.db'), 'x'.repeat(32))
  const media = new Media(join(dir, 'media'))
  const service = new BuiltIndie(store, media, {
    origin: 'https://built.indie.pit.world',
    coinpay: null,
    featureUsd: 19,
    featureDays: 7,
    chains: ['USDC_SOL'],
    screenshots: false,
    fetch: { fetch: web.fetch, resolve: web.resolve },
    claimSecret: 'claim-secret',
    resolveTxt: async (name) => txt[name] ?? [],
  })
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m))
  const app = createApp({ service, auth, adminKey: 'admin-key-0123456789', secureCookies: false, mailer: async (m) => void mail.push(m) })
  const call = (path: string, init: RequestInit = {}, ip = '1.2.3.4') => app.fetch(new Request(`http://localhost${path}`, init), { ip })
  return { store, service, app, call, mail, web, txt }
}

const form = (data: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: new URLSearchParams(data).toString() })
const json = (data: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(data) })

describe('autofetch', () => {
  test('reads everything a homepage offers', async () => {
    const web = fakeWeb()
    const r = await autofetch('acme.test', { fetch: web.fetch, resolve: web.resolve })
    expect(r.name).toBe('Acme')
    expect(r.tagline).toBe('Invoices that pay themselves')
    expect(r.description).toBe('Invoicing that chases late payers for you.')
    expect(r.ogImage).toBe('https://acme.test/og.png')
    expect(r.logo).toBe('https://acme.test/icon-512.png')
    expect(r.images).toEqual(['https://acme.test/shot.png', 'https://acme.test/hero.png'])
    expect(r.videos[0]).toEqual({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', embed: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ' })
    expect(r.socials).toEqual({ github: 'https://github.com/acme', x: 'https://x.com/acmehq', linkedin: 'https://www.linkedin.com/company/acme', discord: 'https://discord.gg/acme' })
    expect(r.tags).toEqual(['invoicing', 'freelancers', 'business', 'finance'])
    expect(r.themeColor).toBe('#123456')
    expect(r.llms?.url).toBe('https://acme.test/llms.txt')
    expect(r.profile).toMatchObject({ kind: 'organization', name: 'Acme Inc' })
    expect(r.kind).toBe('product')
    expect(r.canonical).toBe('https://acme.test/')
    expect(r.feeds).toEqual(['https://acme.test/blog.xml'])
    expect(r.stack?.items).toEqual([{ layer: 'Languages', name: 'TypeScript 5.9' }, { layer: 'Interfaces / Web', name: 'Next.js 16' }, { layer: 'Data', name: 'Postgres 17' }])
    expect(r.pricing).toEqual({ url: 'https://acme.test/.well-known/opensaas.json', currency: 'USD', plans: [{ name: 'Free', price: 0, period: null, trial: null, url: null }, { name: 'Pro', price: 12, period: 'month', trial: '14 days', url: 'https://acme.test/pro' }], cancel: 'https://acme.test/billing' })
    expect(r.openicon).toBe('https://acme.test/.well-known/openicon.json')
    expect(r.sources).toEqual(['homepage', 'llms.txt', 'manifest', 'openprofile.md', 'openstack.md', 'opensaas.json', 'openicon.json', 'json-ld', 'open graph'])
  })

  test('the site’s own OpenSite descriptor wins, and index.allow false is honoured', async () => {
    const declared = fakeWeb({ 'https://acme.test/.well-known/opensite.json': Response.json({ opensite: '0.1', site: { name: 'ACME', web: 'https://acme.test', description: 'Said by the site itself.' } }) })
    const r = await autofetch('https://acme.test', declared)
    expect(r.name).toBe('ACME')
    expect(r.description).toBe('Said by the site itself.')
    expect(r.declared).toBe(true)
    const no = fakeWeb({ 'https://acme.test/.well-known/opensite.json': Response.json({ opensite: '0.1', site: { name: 'x' }, index: { allow: false } }) })
    await expect(autofetch('acme.test', no)).rejects.toThrow('asks not to be indexed')
  })

  test('a manifest short_name is only a last resort for the name', async () => {
    const web = fakeWeb({
      'https://acme.test/': new Response('<html><head><title>family.ancestry</title><link rel="manifest" href="/manifest.json"></head><body></body></html>', { headers: { 'content-type': 'text/html' } }),
      'https://acme.test/manifest.json': Response.json({ name: 'family.ancestry', short_name: 'Family' }),
      'https://acme.test/llms.txt': new Response('', { status: 404 }),
    })
    expect((await autofetch('acme.test', web)).name).toBe('family.ancestry')
  })

  test('robots.txt that shuts us out is respected', async () => {
    const web = fakeWeb({ 'https://acme.test/robots.txt': new Response('User-agent: built.indie\nDisallow: /\n') })
    await expect(autofetch('acme.test', web)).rejects.toThrow('robots.txt')
    expect(robotsBlocks('User-agent: *\nDisallow: /\nAllow: /$\n', '/')).toBe(false)
    expect(robotsBlocks('User-agent: *\nDisallow: /\n', '/pricing')).toBe(true)
    expect(robotsBlocks('User-agent: Googlebot\nDisallow: /\n', '/')).toBe(false)
  })

  test('never fetches private addresses, even through a redirect', async () => {
    expect(() => normalizeUrl('http://localhost:8080')).toThrow()
    expect(() => normalizeUrl('http://10.0.0.1/')).toThrow()
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow()
    expect(privateAddress('::ffff:127.0.0.1')).toBe(true)
    expect(privateAddress('172.20.1.1')).toBe(true)
    expect(privateAddress('93.184.216.34')).toBe(false)
    const web = fakeWeb({ 'https://acme.test/': new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }) })
    await expect(autofetch('acme.test', web)).rejects.toThrow('public internet')
    const rebind = { ...fakeWeb(), resolve: async () => ['127.0.0.1'] }
    await expect(autofetch('acme.test', rebind)).rejects.toThrow('public internet')
  })

  test('tag helpers', () => {
    expect(normalizeTag('#Developer Tools')).toBe('developer tools')
    expect(normalizeTag('BusinessApplication')).toBe('business')
    expect(normalizeTag('x')).toBeNull()
    expect(cleanTags(['AI', 'ai', '#ai', 'Open  Source', 'a'])).toEqual(['ai', 'open source'])
    expect(inferTags('Follow any team in the world and get told before they play. Never miss a game.')).toEqual(['alerts', 'sports'])
    expect(inferTags('Rent a US phone number that receives SMS and one-time codes')).toEqual(['sms', 'verification'])
    expect(inferTags('Nothing to see here')).toEqual([])
    expect(tagsFor(['Games'], { description: 'an sms tool' })).toEqual(['games'])
    expect(tagsFor([], { description: 'an sms tool' })).toEqual(['sms'])
  })

  test('helpers', () => {
    expect(splitTitle('Acme | Invoices that pay themselves')).toEqual(['Acme', 'Invoices that pay themselves'])
    expect(splitTitle('The quickest way to ship invoices - Acme')).toEqual(['Acme', 'The quickest way to ship invoices'])
    expect(readLlms('# Name\n\n> Summary line.')).toEqual({ title: 'Name', summary: 'Summary line.' })
    expect(readLlms('<!doctype html><html>')).toBeNull()
    expect(videoFrom('https://youtu.be/dQw4w9WgXcQ')?.embed).toBe('https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(videoFrom('https://vimeo.com/123456789')?.embed).toBe('https://player.vimeo.com/video/123456789')
    expect(videoFrom('https://www.loom.com/share/0123456789abcdef0123456789abcdef')?.kind).toBe('loom')
    expect(videoFrom('javascript:alert(1)')).toBeNull()
    expect(sniff(PNG(1, 1))).toBe('png')
    expect(sniff(new TextEncoder().encode('<html>'))).toBeNull()
    expect(dimensions(PNG(640, 480), 'png')).toEqual({ width: 640, height: 480 })
    expect(slugify('Acme Invoicing!')).toBe('acme-invoicing')
    expect(slugify('API')).toBe('product-api')
  })
})

describe('the site', () => {
  test('anyone launches free; it is live, with pictures saved locally', async () => {
    const { call, store } = setup()
    const r = await call('/submit', form({ url: 'acme.test' }))
    expect(r.status).toBe(302)
    expect(r.headers.get('location')).toBe('/p/acme?launched=1')
    const p = store.bySlug('acme')!
    expect(p.status).toBe('live')
    expect(p.logo).toBe('logo.png')
    expect(p.ogImage).toBe('card.png')
    expect(p.images).toEqual(['shot-1.png', 'shot-2.png'])
    const page = await (await call('/p/acme?launched=1')).text()
    expect(page).toContain('Acme is live')
    expect(page).toContain('Claim it')
    expect(page).toContain('youtube-nocookie.com/embed/dQw4w9WgXcQ')
    expect(page).toContain('<link rel="opensite"')
    expect(page).toContain('Built with')
    expect(page).toContain('Postgres 17')
    expect(page).toContain('acme.test/billing')
    expect(page).toContain('class="i"')
    const pic = await call(`/m/${p.id}/logo.png`)
    expect(pic.headers.get('content-type')).toBe('image/png')
    expect(pic.headers.get('content-security-policy')).toContain('sandbox')
    // The same site again comes back as the existing listing.
    expect((await call('/submit', form({ url: 'https://www.acme.test/' }))).headers.get('location')).toBe('/p/acme?existing=1')
    const home = await (await call('/')).text()
    expect(home).toContain('/p/acme')
    expect(home).toContain('crawlproof.com/stats.js')
    // The Profullstack ring is server-rendered (the verifier never runs script), and no ad sits in or against the footer.
    const footer = home.slice(home.indexOf('<footer'))
    expect(footer).toContain('https://rssamplifier.com/ring/profullstack/next?from=https%3A%2F%2Fbuilt.indie.pit.world%2F')
    expect(footer).not.toContain('crawlproof.com/api/ads')
    expect(home.slice(home.indexOf('</main>'), home.indexOf('<footer'))).not.toContain('ad-unit')
  })

  test('one vote per visitor; the badge counts it; other sites cannot vote for our visitors', async () => {
    const { call } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    const vote = (ip: string) => call('/p/acme/vote', { method: 'POST', headers: { accept: 'application/json', 'sec-fetch-site': 'same-origin' } }, ip)
    expect(await (await vote('5.5.5.5')).json()).toMatchObject({ votes: 1, counted: true })
    expect(await (await vote('5.5.5.5')).json()).toMatchObject({ votes: 1, counted: false })
    expect(await (await vote('6.6.6.6')).json()).toMatchObject({ votes: 2, counted: true })
    expect((await call('/p/acme/vote', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }, '7.7.7.7')).status).toBe(403)
    const badge = await call('/badge/acme.svg')
    expect(badge.headers.get('content-type')).toContain('image/svg+xml')
    expect(await badge.text()).toContain('>2<')
    const board = await (await call('/api/v1/products?window=today')).json()
    expect(board.products[0]).toMatchObject({ slug: 'acme', votes: 2 })
  })

  test('sign in by email, claim by DNS, then edit; the API key works for the CLI', async () => {
    const { call, mail, store, txt } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    expect((await call('/p/acme/edit')).headers.get('location')).toBe('/login?next=%2Fp%2Facme%2Fedit')
    await call('/login', form({ email: 'Ada@Example.com', next: '/p/acme/claim' }))
    expect(mail[0]!.to).toBe('ada@example.com')
    const token = mail[0]!.text.match(/token=([\w-]+)/)![1]!
    const verified = await call(`/auth/verify?token=${token}`)
    expect(verified.headers.get('location')).toBe('/p/acme/claim')
    const cookie = verified.headers.get('set-cookie')!.split(';')[0]!
    expect((await call(`/auth/verify?token=${token}`)).status).toBe(400)
    const authed = (init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), cookie } })
    // Not theirs yet: editing sends them to claim it.
    expect((await call('/p/acme/edit', authed())).headers.get('location')).toBe('/p/acme/claim')
    const claimPage = await (await call('/p/acme/claim', authed())).text()
    const value = claimPage.match(new RegExp(`${CLAIM_PREFIX}[\\w-]+`))![0]
    expect(claimPage).toContain('_built-indie.acme.test')
    expect(claimPage).toContain('Copy as Markdown for AI')
    expect(claimPage).toContain('The badge on your homepage (easiest)')
    expect(claimPage).toContain('Or a DNS record')
    expect(claimPage.indexOf('images.svg?id=')).toBeLessThan(claimPage.indexOf('_built-indie.acme.test'))
    expect((await call('/p/acme/claim.md')).headers.get('location')).toBe('/login?next=%2Fp%2Facme%2Fclaim.md')
    const md = await call('/p/acme/claim.md', authed())
    expect(md.headers.get('content-type')).toContain('text/markdown')
    const mdText = await md.text()
    expect(mdText).toContain('# Claim Acme on built.indie')
    expect(mdText).toContain(`| Value / content | \`${value}\` |`)
    expect(mdText).toContain('dig +short TXT _built-indie.acme.test @1.1.1.1')
    expect(mdText).toContain('builtindie claim acme')
    expect(await (await call('/p/acme/claim', authed(form({})))).text()).toContain('did not find the badge or the record')
    txt['_built-indie.acme.test'] = [[value]]
    expect(await (await call('/p/acme/claim', authed(form({})))).text()).toContain('is yours ✓')
    const user = store.findOrCreateUser('ada@example.com')
    expect(store.bySlug('acme')!.ownerId).toBe(user.id)
    // Edit on the web.
    const saved = await call('/p/acme/edit', authed(form({ action: 'save', name: 'Acme', tagline: 'Get paid on time', description: 'New words.', tags: 'invoicing, #saas', videos: 'https://youtu.be/dQw4w9WgXcQ', makerName: 'Ada', makerProfile: 'https://ada.test/openprofile.md' })))
    expect(await saved.text()).toContain('Saved.')
    const p = store.bySlug('acme')!
    expect(p.tagline).toBe('Get paid on time')
    expect(p.tags).toEqual(['invoicing', 'saas'])
    expect(p.makerVerified).toBe(true)
    expect(await (await call(`/makers/${p.makerId}/openprofile.md`)).text()).toContain('# Ada Lovelace')
    // An API key, and the CLI with it.
    const me = await (await call('/me/key', authed({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }))).text()
    const key = me.match(/bi_[\w-]{20,}/)![0]
    const client = new BuiltIndieClient('http://localhost', key, ((u: string, i: RequestInit) => call(new URL(u).pathname + new URL(u).search, i)) as unknown as typeof fetch)
    const lines: string[] = []
    expect(await main(['edit', 'acme', '--tagline', 'From the terminal'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)).toBe(0)
    expect(store.bySlug('acme')!.tagline).toBe('From the terminal')
    expect(await main(['me', '--json'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)).toBe(0)
    expect(JSON.parse(lines.at(-1)!).products[0]).toMatchObject({ slug: 'acme', owner: true })
    // Someone else's key cannot touch it.
    const other = store.newApiKey(store.findOrCreateUser('mallory@example.com').id)
    expect((await call('/api/v1/products/acme', { method: 'PATCH', headers: { authorization: `Bearer ${other}`, 'content-type': 'application/json' }, body: '{"name":"pwned"}' })).status).toBe(401)
  })

  test('a signed-in submitter gets a draft to check, and may edit it until the owner claims it', async () => {
    const { call, mail, store, txt } = setup()
    await call('/login', form({ email: 'sub@example.com' }))
    const token = mail[0]!.text.match(/token=([\w-]+)/)![1]!
    const cookie = (await call(`/auth/verify?token=${token}`)).headers.get('set-cookie')!.split(';')[0]!
    const r = await call('/submit', { ...form({ url: 'acme.test' }), headers: { ...form({}).headers, cookie } })
    expect(r.headers.get('location')).toBe('/p/acme/edit?fresh=1')
    expect(store.bySlug('acme')!.status).toBe('draft')
    expect((await call('/p/acme')).status).toBe(404)
    await call('/p/acme/edit', { ...form({ action: 'publish', name: 'Acme' }), headers: { ...form({}).headers, cookie } })
    expect(store.bySlug('acme')!.status).toBe('live')
    // The domain owner claims it; the submitter loses edit rights.
    const owner = store.findOrCreateUser('owner@acme.test')
    const value = `${CLAIM_PREFIX}${setupToken(store, owner.id)}`
    txt['acme.test'] = [['v=spf1 -all'], [value]]
    const key = store.newApiKey(owner.id)
    const claimed = await (await call('/api/v1/products/acme/claim', json({}, { authorization: `Bearer ${key}` }))).json()
    expect(claimed.claimed).toBe(true)
    expect((await call('/p/acme/edit', { headers: { cookie } })).headers.get('location')).toBe('/p/acme/claim')
  })

  test('the badge works as a claim: the right token claims and earns the ✓; another account or no token does not; DNS still wins first', async () => {
    let home = HOME
    const web = fakeWeb({ 'https://acme.test/': () => new Response(home, { headers: { 'content-type': 'text/html' } }) })
    const { call, store, txt } = setup(web)
    await call('/submit', form({ url: 'acme.test' }))
    const owner = store.findOrCreateUser('owner@acme.test')
    const mallory = store.findOrCreateUser('mallory@example.com')
    const key = store.newApiKey(owner.id)
    const auth = { authorization: `Bearer ${key}` }
    const claim = async () => (await call('/api/v1/products/acme/claim', json({}, auth))).json()
    const info = await (await call('/api/v1/products/acme/claim', { headers: auth })).json()
    const token = setupToken(store, owner.id)
    const id = store.badgeId(store.bySlug('acme')!.id, owner.id)
    expect(info.badge).toBe(`<a href="https://built.indie.pit.world/p/acme"><img src="https://built.indie.pit.world/images.svg?id=${id}" alt="Launched on built.indie" width="200" height="44"></a>`)
    expect(info.markdown).toContain('Option A (easiest): the badge on the homepage')
    expect(info.markdown).toContain(`images.svg?id=${id}`)
    // The badge route ignores the extra query.
    expect((await call(`/badge/acme.svg?claim=${token}`)).status).toBe(200)
    // No badge: not claimed, and we say we looked at the homepage too.
    const none = await claim()
    expect(none).toMatchObject({ claimed: false, badge: info.badge })
    expect(none.looked).toContain('https://acme.test/')
    // A plain badge (no token), and another account's badge, do not claim it.
    home = HOME.replace('</body>', '<a href="https://built.indie.pit.world/p/acme?ref=badge"><img src="https://built.indie.pit.world/badge/acme.svg"></a></body>')
    expect((await claim()).claimed).toBe(false)
    const theirs = setupToken(store, mallory.id)
    home = HOME.replace('</body>', `<a href="https://built.indie.pit.world/p/acme"><img src="https://built.indie.pit.world/badge/acme.svg?claim=${theirs}"></a></body>`)
    expect((await claim()).claimed).toBe(false)
    // A token on someone else's host does not count either.
    home = HOME.replace('</body>', `<img src="https://evil.test/badge/acme.svg?claim=${token}"></body>`)
    expect((await claim()).claimed).toBe(false)
    expect(store.bySlug('acme')!.ownerId).toBeNull()
    expect(store.bySlug('acme')!.verifiedAt).toBeNull()
    // The right badge claims it, and it is a followed link with the ✓.
    home = HOME.replace('</body>', `${info.badge}</body>`)
    expect(await claim()).toMatchObject({ claimed: true, method: 'badge' })
    expect(store.bySlug('acme')!.ownerId).toBe(owner.id)
    expect(store.bySlug('acme')!.verifiedAt).toBeGreaterThan(0)
    // Mallory takes it over with the bare verify string in a meta tag (HTML-escaped &amp; is fine too).
    const mkey = store.newApiKey(mallory.id)
    home = HOME.replace('</head>', `<meta name="built-indie-verify" content="${CLAIM_PREFIX}${theirs}"></head>`)
    expect(await (await call('/api/v1/products/acme/claim', json({}, { authorization: `Bearer ${mkey}` }))).json()).toMatchObject({ claimed: true, method: 'badge' })
    home = HOME.replace('</body>', `<img src="https://built.indie.pit.world/badge/acme.svg?theme=light&amp;claim=${token}"></body>`)
    expect(await claim()).toMatchObject({ claimed: true, method: 'badge' })
    // DNS is still tried first.
    home = HOME
    const dkey = store.newApiKey(mallory.id)
    txt['_built-indie.acme.test'] = [[`${CLAIM_PREFIX}${theirs}`]]
    expect(await (await call('/api/v1/products/acme/claim', json({}, { authorization: `Bearer ${dkey}` }))).json()).toMatchObject({ claimed: true, method: 'dns' })
    expect(store.bySlug('acme')!.ownerId).toBe(mallory.id)
  })

  test('the badge by site: /for.svg?site= renders the listing for that homepage, /for?site= goes to it', async () => {
    const { call, store } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    const img = await call('/for.svg?site=https%3A%2F%2Fwww.acme.test%2F')
    expect(img.status).toBe(200)
    expect(await img.text()).toBe(await (await call('/badge/acme.svg')).text())
    expect((await call('/for.svg?site=https://acme.test/')).status).toBe(200)
    expect((await call('/for.svg?site=https://nobody.test/')).status).toBe(404)
    expect((await call('/for.svg')).status).toBe(404)
    expect((await call('/for?site=https://acme.test/')).headers.get('location')).toBe('/p/acme?ref=badge')
    expect((await call('/for?site=https://nobody.test/')).headers.get('location')).toBe('/')
    expect(store.unverified().map((p) => p.slug)).toEqual(['acme'])
  })

  test('the badge id: one per listing and account; /images.svg?id renders it; your id claims and verifies, another account\'s only verifies', async () => {
    let home = HOME
    const web = fakeWeb({ 'https://acme.test/': () => new Response(home, { headers: { 'content-type': 'text/html' } }) })
    const { call, store, txt } = setup(web)
    await call('/submit', form({ url: 'acme.test' }))
    const p = store.bySlug('acme')!
    const owner = store.findOrCreateUser('owner@acme.test')
    const mallory = store.findOrCreateUser('mallory@example.com')
    const okey = store.newApiKey(owner.id)
    const mkey = store.newApiKey(mallory.id)
    const claimAs = async (key: string) => (await call('/api/v1/products/acme/claim', json({}, { authorization: `Bearer ${key}` }))).json()
    const infoAs = async (key: string) => (await call('/api/v1/products/acme/claim', { headers: { authorization: `Bearer ${key}` } })).json()
    // Stable per product + account, different across accounts, short and URL-safe.
    const first = await infoAs(okey)
    const id = first.badge.match(/images\.svg\?id=([A-Za-z0-9_-]+)/)![1]
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/)
    expect((await infoAs(okey)).badge).toBe(first.badge)
    expect(store.badgeId(p.id, owner.id)).toBe(id)
    const theirs = store.badgeId(p.id, mallory.id)
    expect(theirs).not.toBe(id)
    expect((await infoAs(mkey)).badge).toContain(`images.svg?id=${theirs}`)
    // The route renders the same live badge as /badge/<slug>.svg, with the same headers.
    const img = await call(`/images.svg?id=${id}`)
    const plain = await call('/badge/acme.svg')
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe(plain.headers.get('content-type'))
    expect(img.headers.get('cache-control')).toBe('public, max-age=300')
    expect(await img.text()).toBe(await plain.text())
    expect((await call('/images.svg?id=nope')).status).toBe(404)
    expect((await call('/images.svg')).status).toBe(404)
    // An unknown id on the homepage does nothing.
    home = HOME.replace('</body>', '<img src="https://built.indie.pit.world/images.svg?id=AAAAAAAAAAAAAAAA"></body>')
    expect((await claimAs(okey)).claimed).toBe(false)
    expect((await (await call('/api/v1/products/acme/verify', json({}))).json()).verified).toBe(false)
    // Our id on someone else's host does nothing either.
    home = HOME.replace('</body>', `<img src="https://evil.test/images.svg?id=${id}"></body>`)
    expect((await claimAs(okey)).claimed).toBe(false)
    // Mallory's badge (an image only, no link) verifies the listing but does not claim it for the owner.
    home = HOME.replace('</body>', `<img src="https://built.indie.pit.world/images.svg?id=${theirs}"></body>`)
    expect((await claimAs(okey)).claimed).toBe(false)
    expect(store.bySlug('acme')!.ownerId).toBeNull()
    expect((await (await call('/api/v1/products/acme/verify', json({}))).json()).verified).toBe(true)
    expect(store.bySlug('acme')!.verifiedAt).toBeGreaterThan(0)
    store.setVerified(p.id, null)
    // The owner's own badge claims it and marks it verified in the same step.
    home = HOME.replace('</body>', `${first.badge.replace('?id=', '?theme=light&amp;id=')}</body>`)
    expect(await claimAs(okey)).toMatchObject({ claimed: true, method: 'badge' })
    expect(store.bySlug('acme')!.ownerId).toBe(owner.id)
    expect(store.bySlug('acme')!.verifiedAt).toBeGreaterThan(0)
    // DNS still works for the other account.
    home = HOME
    txt['_built-indie.acme.test'] = [[`${CLAIM_PREFIX}${setupToken(store, mallory.id)}`]]
    expect(await claimAs(mkey)).toMatchObject({ claimed: true, method: 'dns' })
    expect(store.bySlug('acme')!.ownerId).toBe(mallory.id)
  })

  test('open-spec documents and machine files', async () => {
    const { call } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    const record = await (await call('/p/acme/opensite.json')).json()
    expect(record).toMatchObject({ opensite: '0.1', kind: 'product', source: 'read', canonical: 'https://acme.test/' })
    const profile = await (await call('/p/acme/openprofile.md')).text()
    expect(profile).toContain('# Acme')
    expect(profile).toMatch(/Kind\*\*: organization/)
    expect(await (await call('/api/v1/sites?url=acme.test')).json()).toMatchObject({ opensite: '0.1' })
    expect(await (await call('/.well-known/opensite.json')).json()).toMatchObject({ site: { name: 'built.indie' } })
    expect(await (await call('/.well-known/openprofile.md')).text()).toContain('organization')
    expect(await (await call('/feed.xml')).text()).toContain('/p/acme')
    expect(await (await call('/sitemap.xml')).text()).toContain('/p/acme')
    expect((await call('/manifest.webmanifest')).headers.get('content-type')).toContain('manifest')
    expect(await (await call('/sw.js')).text()).toContain('caches')
    const icons = await (await call('/icons/openicon.json')).json()
    expect(icons.icons.find((i: any) => i.key === 'github')).toMatchObject({ brand: true })
    expect(await (await call('/.well-known/openicon.json')).json()).toMatchObject({ openicon: '0.1' })
    expect(await (await call('/.well-known/openstack.md')).text()).toContain('# built.indie')
    expect((await call('/icons/svg/github.svg')).headers.get('content-type')).toBe('image/svg+xml')
  })

  test('tags: declared ones win, otherwise topics from the listing; browse at /tags and /t/<tag>, API and backfill', async () => {
    const bare = `<!doctype html><html><head><title>Nightcell — Two operatives</title>
<meta name="description" content="A co-op tactical game. Two operatives, one manufactured war. Play both sides."></head><body><h1>Two operatives</h1></body></html>`
    const { call, store } = setup(fakeWeb({ 'https://nightcell.test/': () => new Response(bare, { headers: { 'content-type': 'text/html' } }) }))
    await call('/submit', form({ url: 'acme.test' }))
    await call('/submit', form({ url: 'nightcell.test' }))
    // Acme declares keywords, a JSON-LD category and manifest categories; those are its tags.
    expect(store.bySlug('acme')!.tags).toEqual(['invoicing', 'freelancers', 'business', 'finance'])
    // Nightcell declares nothing, so its own words say what it is.
    expect(store.bySlug('nightcell')!.tags).toEqual(['tactical', 'game'])

    const product = await (await call('/p/nightcell')).text()
    expect(product).toContain('<a class="tag" href="/t/game">game</a>')
    const tags = await (await call('/tags')).text()
    expect(tags).toContain('href="/t/game"')
    expect(tags).toContain('href="/t/invoicing"')
    const board = await (await call('/t/game')).text()
    expect(board).toContain('/p/nightcell')
    expect(board).not.toContain('/p/acme"')
    expect((await call('/t/Game')).headers.get('location')).toBe('/t/game')
    expect((await call('/t/x')).status).toBe(404)
    expect((await (await call('/sitemap.xml')).text())).toContain('/t/tactical')

    const api = (await (await call('/api/v1/products?tag=game')).json()) as any
    expect(api.tag).toBe('game')
    expect(api.products.map((p: any) => p.slug)).toEqual(['nightcell'])
    expect((await call('/api/v1/products?tag=x')).status).toBe(400)
    const all = (await (await call('/api/v1/tags')).json()) as any
    expect(all.tags).toContainEqual({ tag: 'game', count: 1 })

    // A listing from before inference has no tags; the backfill gives it some and leaves tagged ones alone.
    store.update(store.bySlug('nightcell')!.id, { tags: [] })
    expect(store.backfillTags()).toBe(1)
    expect(store.bySlug('nightcell')!.tags).toEqual(['tactical', 'game'])
    expect(store.bySlug('acme')!.tags).toEqual(['invoicing', 'freelancers', 'business', 'finance'])
  })

  test('the admin takes a listing down', async () => {
    const { call, store } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    expect((await call('/api/v1/products/acme', { method: 'DELETE', headers: { authorization: 'Bearer admin-key-0123456789' } })).status).toBe(200)
    expect(store.bySlug('acme')!.status).toBe('hidden')
    expect((await call('/p/acme')).status).toBe(404)
  })

  test('the admin may launch a whole portfolio at once; anyone else is capped', async () => {
    const sites: Record<string, () => Response> = {}
    for (let i = 0; i < 40; i++) sites[`https://s${i}.test/`] = () => new Response(`<html><head><title>Site ${i}</title></head><body></body></html>`, { headers: { 'content-type': 'text/html' } })
    const { call } = setup(fakeWeb(sites))
    const admin = { authorization: 'Bearer admin-key-0123456789' }
    for (let i = 0; i < 25; i++) expect((await call('/api/v1/products', json({ url: `s${i}.test` }, admin))).status).toBe(201)
    const statuses: number[] = []
    for (let i = 25; i < 37; i++) statuses.push((await call('/api/v1/products', json({ url: `s${i}.test` }, { authorization: 'Bearer wrong' }), '5.6.7.8')).status)
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true)
    expect(statuses.slice(10).every((s) => s >= 400)).toBe(true)
  })
})

/** The claim token the service would hand this user for acme.test. */
function setupToken(store: Store, userId: string): string {
  const svc = new BuiltIndie(store, new Media('/nonexistent'), { origin: '', coinpay: null, featureUsd: 0, featureDays: 0, chains: [], claimSecret: 'claim-secret' })
  return svc.claimToken(store.bySlug('acme')!, store.user(userId)!)
}

describe('plumbing', () => {
  test('client address through the pit.world relay', () => {
    const h = (o: Record<string, string>) => new Headers(o)
    expect(clientIp('127.0.0.1', h({ 'x-real-ip': '8.8.4.4' }), ['23.95.228.174'])).toBe('8.8.4.4')
    expect(clientIp('127.0.0.1', h({ 'x-real-ip': '23.95.228.174', 'x-moshpit-name': 'built.indie', 'x-forwarded-for': '9.9.9.9, 23.95.228.174' }), ['23.95.228.174'])).toBe('9.9.9.9')
    expect(clientIp('127.0.0.1', h({ 'x-real-ip': '1.1.1.1', 'x-moshpit-name': 'built.indie', 'x-forwarded-for': '9.9.9.9' }), ['23.95.228.174'])).toBe('1.1.1.1')
    expect(clientIp('5.5.5.5', h({ 'x-real-ip': '9.9.9.9' }), [])).toBe('5.5.5.5')
  })

  test('OpenIcon: inline SVG and terminal glyphs by rule 6', () => {
    expect(icon('github')).toContain('currentColor')
    expect(icon('email')).toBe(icon('mail'))
    expect(glyph('mail', 'ascii')).toBe('@')
    expect(glyph('mail', 'unicode')).toBe('✉')
    expect(glyph('nope', 'unicode')).toBe('')
  })

  test('public TXT lookups ask each resolver on its own and merge what they say', async () => {
    const down = { resolveTxt: async () => { throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' }) } }
    const up = { resolveTxt: async () => [['built-indie-verify=abc']] }
    expect(await publicTxt('x', [down as any, up as any])).toEqual([['built-indie-verify=abc']])
    expect(await publicTxt('x', [down as any, down as any])).toEqual([])
  })

  test('cli args and tui keys', () => {
    expect(parseArgs(['launch', 'a.com', '--maker', 'Ada', '--json', '--tags=x,y'])).toEqual({ words: ['launch', 'a.com'], flags: { maker: 'Ada', json: true, tags: 'x,y' } })
    const s = initialState()
    expect(onKey(s, { name: 'right', key: 'right' })).toBe('load')
    expect(s.window).toBe(1)
    expect(onKey(s, { name: 'l', key: 'l', char: 'l' })).toBeNull()
    expect(s.typing).toBe('')
    onKey(s, { name: 'a', key: 'a', char: 'a' })
    expect(onKey(s, { name: 'enter', key: 'enter' })).toBe('launch')
    s.typing = null
    expect(onKey(s, { name: 'q', key: 'q', char: 'q' })).toBe('quit')
  })
})

describe('invites', () => {
  const BETA = `<!doctype html><html><head><title>Beta: a second product</title><meta name="description" content="Beta does a second thing well."></head><body><h1>Beta</h1></body></html>`
  const signIn = async (call: ReturnType<typeof setup>['call'], mail: Mail[], email: string, cookie = '') => {
    await call('/login', { ...form({ email }), headers: { ...form({}).headers, ...(cookie ? { cookie } : {}) } })
    const token = mail.at(-1)!.text.match(/token=([\w-]+)/)![1]!
    // Opened in another browser on purpose: no invite cookie here, the code rides in the link.
    return (await call(`/auth/verify?token=${token}`)).headers.get('set-cookie')!.split(';')[0]!
  }

  test('a new member who joins through your link and launches earns you a free Featured week; the board and the homepage show it', async () => {
    const { call, mail, store } = setup(fakeWeb({ 'https://beta.test/': new Response(BETA, { headers: { 'content-type': 'text/html' } }) }))
    const as = (cookie: string, init: RequestInit = {}) => ({ ...init, headers: { ...(init.headers as Record<string, string>), cookie } })
    const ann = await signIn(call, mail, 'ann@example.com')
    const invitePage = await (await call('/invite', as(ann))).text()
    const code = invitePage.match(/\/i\/([\w-]+)/)![1]!
    expect(invitePage).toContain('Your invite link')
    // The invitee follows the link: a landing page, and the code kept in a cookie.
    const landing = await call(`/i/${code}`)
    expect(await landing.text()).toContain('invited you')
    const ref = landing.headers.get('set-cookie')!.split(';')[0]!
    expect(ref).toBe(`bi_ref=${code}`)
    expect(await (await call('/login', { headers: { cookie: ref } })).text()).toContain('invited you')
    expect((await call('/i/nope')).headers.get('location')).toBe('/invite')
    const bob = await signIn(call, mail, 'bob@example.com', ref)
    const annId = store.userByEmail('ann@example.com')!.id
    expect(store.inviteStats(annId)).toMatchObject({ invited: 1, launched: 0, credits: 0 })
    // Joining is not enough: the credit comes when Bob's listing goes live.
    await call('/submit', as(bob, form({ url: 'acme.test' })))
    expect(store.inviteStats(annId).credits).toBe(0)
    await call('/p/acme/edit', as(bob, form({ action: 'publish', name: 'Acme' })))
    expect(store.inviteStats(annId)).toMatchObject({ invited: 1, launched: 1, credits: 1 })
    expect(mail.at(-1)).toMatchObject({ to: 'ann@example.com', subject: 'You earned a free Featured week on built.indie' })
    // Once per member: Bob's next launch earns nothing more.
    expect(store.earnInvite(store.userByEmail('bob@example.com')!.id, 'x')).toBeNull()
    // An existing member, or yourself, never counts.
    expect(store.recordInvite(annId, code)).toBe(false)
    await signIn(call, mail, 'bob@example.com', ref)
    expect(store.inviteStats(annId).invited).toBe(1)
    // The leaderboard (@profullstack/leaderboard) ranks Ann, by the name she picks, never her email.
    expect(await (await call('/invite/name', as(ann, form({ displayName: '  Ann   the Maker ' })))).text()).toContain('Ann the Maker')
    const top = await (await call('/leaderboard/invites.json?period=week')).json()
    expect(top.rows[0]).toMatchObject({ rank: 1, name: 'Ann the Maker', value: 1 })
    expect(top.rows[0].badges.map((b: { id: string }) => b.id)).toContain('first-invite')
    expect((await call('/leaderboard.json')).status).toBe(200)
    expect(await (await call('/leaderboard/invites.xml')).text()).toContain('<rss')
    expect(await (await call('/leaderboard')).text()).toContain('/leaderboard/embed.js')
    expect((await call('/leaderboard/embed.js')).headers.get('content-type')).toContain('javascript')
    const home = await (await call('/')).text()
    expect(home).toContain('Invite a maker, get Featured free')
    expect(home).toContain('Ann the Maker')
    expect(JSON.stringify(top)).not.toContain('ann@example.com')
    // Ann spends the credit on her own listing.
    await call('/submit', as(ann, form({ url: 'beta.test' })))
    const b = store.byUrl('https://beta.test/')!.slug
    await call(`/p/${b}/edit`, as(ann, form({ action: 'publish', name: 'Beta' })))
    expect(await (await call(`/p/${b}`, as(ann))).text()).toContain('Use a free invite credit')
    expect((await call('/p/acme/credit', as(ann, form({})))).headers.get('location')).toBe('/p/acme')
    expect((await call(`/p/${b}/credit`, as(ann, form({})))).headers.get('location')).toBe(`/p/${b}?featured=credit`)
    expect(store.bySlug(b)!.featuredUntil!).toBeGreaterThan(Date.now() + 6 * 86400_000)
    expect(store.inviteStats(annId)).toMatchObject({ credits: 0, used: 1 })
    expect((await call(`/p/${b}/credit`, as(ann, form({})))).status).toBe(400)
    expect(await (await call('/')).text()).toContain('Featured')
    // The same from the API and the CLI.
    const key = store.newApiKey(annId)
    const client = new BuiltIndieClient('http://localhost', key, ((u: string, i: RequestInit) => call(new URL(u).pathname + new URL(u).search, i)) as unknown as typeof fetch)
    const lines: string[] = []
    expect(await main(['invite'], { log: (t) => lines.push(t), error: (t) => lines.push(t) }, client)).toBe(0)
    expect(lines.at(-1)).toContain(`https://built.indie.pit.world/i/${code}`)
    expect((await call(`/api/v1/products/${store.byUrl('https://beta.test/')!.slug}/credit`, json({}, { authorization: `Bearer ${key}` }))).status).toBe(400)
  })

  test('a listing taken down for spam takes back the credit it earned, if unspent', async () => {
    const { call, mail, store } = setup()
    const ann = await signIn(call, mail, 'ann@example.com')
    const code = (await (await call('/invite', { headers: { cookie: ann } })).text()).match(/\/i\/([\w-]+)/)![1]!
    const bob = await signIn(call, mail, 'bob@example.com', `bi_ref=${code}`)
    await call('/submit', { ...form({ url: 'acme.test' }), headers: { ...form({}).headers, cookie: bob } })
    await call('/p/acme/edit', { ...form({ action: 'publish', name: 'Acme' }), headers: { ...form({}).headers, cookie: bob } })
    const annId = store.userByEmail('ann@example.com')!.id
    expect(store.inviteStats(annId).credits).toBe(1)
    await call('/api/v1/products/acme', { method: 'DELETE', headers: { authorization: 'Bearer admin-key-0123456789' } })
    expect(store.inviteStats(annId)).toMatchObject({ launched: 0, credits: 0 })
  })
})
