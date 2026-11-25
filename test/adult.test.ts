/**
 * The Adult (18+) category: explicit, never inferred, and shown to signed-in members only.
 *
 * Two sites are launched side by side: peach.test in Adult (18+) and acme.test in public.
 * Every public surface must carry acme and never peach; a member reaches peach only
 * inside the adult category.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth, type Mail } from '../src/auth.ts'
import { categorize, CATEGORIES, parseQuery, search } from '../src/browse.ts'
import { BuiltIndieClient } from '../src/client.ts'
import { Store } from '../src/db.ts'
import { Media } from '../src/media.ts'
import { createApp } from '../src/server.ts'
import { BuiltIndie } from '../src/service.ts'

const page = (title: string, description: string, extra = '') => () =>
  new Response(`<!doctype html><html><head><title>${title}</title><meta name="description" content="${description}">${extra}</head><body><h1>${title}</h1></body></html>`, { headers: { 'content-type': 'text/html; charset=utf-8' } })

const PNG = () => {
  const b = new Uint8Array(33)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(b.buffer).setUint32(16, 512)
  new DataView(b.buffer).setUint32(20, 512)
  return new Response(b)
}

const MAKER = `# Peach Studio\n\n- **Kind**: organization\n- **Web**: https://peach.test\n\nMakes Peachy.\n\n## Accounts\n\n- https://peach.test\n`

const PAGES: Record<string, () => Response> = {
  'https://acme.test/': page('Acme — Invoices that pay themselves', 'Acme sends invoices for freelancers.', '<meta name="keywords" content="invoicing, zebratag">'),
  'https://peach.test/': page('Peachy — A quiet studio', 'Peachy is an independent studio site for grown-ups.', '<meta name="keywords" content="peachtag, studio"><link rel="apple-touch-icon" href="/logo.png">'),
  'https://peach.test/logo.png': PNG,
  'https://peach.test/.well-known/openprofile.md': () => new Response(MAKER),
  'https://plum.test/': page('Plum — Another one', 'Plum is a second site.'),
  // A homepage that will not be read: an age gate answering 403.
  'https://walled.test/': () => new Response('blocked', { status: 403 }),
}

/** Anything of the adult listing (its page, words, maker or site), as opposed to a search box echoing what was typed. */
const LEAK = /\/p\/peachy|grown-ups|Peach Studio|peach\.test|>Peachy/i

const ADMIN = { authorization: 'Bearer admin-key-0123456789' }

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'builtindie-adult-'))
  const store = new Store(join(dir, 'test.db'), 'x'.repeat(32))
  const fetchImpl = (async (input: string | URL) => PAGES[String(input)]?.() ?? new Response('not found', { status: 404 })) as unknown as typeof fetch
  const service = new BuiltIndie(store, new Media(join(dir, 'media')), {
    origin: 'https://built.indie.pit.world',
    coinpay: { baseUrl: 'https://coinpay.test', apiKey: 'k', businessId: 'b', webhookSecret: 's', fetch: (async () => Response.json({ id: 'cs_1', url: 'https://coinpay.test/checkout/cs_1' })) as unknown as typeof fetch },
    featureUsd: 19,
    featureDays: 7,
    screenshots: false,
    fetch: { fetch: fetchImpl, resolve: async () => ['93.184.216.34'] },
    claimSecret: 'claim-secret',
    resolveTxt: async () => [],
  })
  const mail: Mail[] = []
  const auth = new Auth(store, async (m) => void mail.push(m))
  const app = createApp({ service, auth, adminKey: 'admin-key-0123456789', secureCookies: false, mailer: async (m) => void mail.push(m) })
  const call = (path: string, init: RequestInit = {}, ip = '1.2.3.4') => app.fetch(new Request(`http://localhost${path}`, init), { ip })
  const signIn = async (email: string) => {
    await call('/login', form({ email }))
    const token = mail.at(-1)!.text.match(/token=([\w-]+)/)![1]!
    return (await call(`/auth/verify?token=${token}`)).headers.get('set-cookie')!.split(';')[0]!
  }
  return { store, service, call, mail, signIn }
}

const form = (data: Record<string, string>, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...headers }, body: new URLSearchParams(data).toString() })
const json = (data: unknown, headers: Record<string, string> = {}, method = 'POST') => ({ method, headers: { 'content-type': 'application/json', accept: 'application/json', ...headers }, body: JSON.stringify(data) })

/** peach.test live in Adult (18+) (seeded by staff), acme.test live in public. */
async function seeded() {
  const s = setup()
  expect((await s.call('/submit', form({ url: 'acme.test' }))).status).toBe(302)
  const made = await s.call('/api/v1/products', json({ url: 'peach.test', category: 'adult', name: 'Peachy', description: 'An independent studio for grown-ups.', tags: ['peachtag', 'studio'], maker_profile: 'https://peach.test/.well-known/openprofile.md' }, ADMIN))
  expect(made.status).toBe(201)
  const body = (await made.json()) as { product: { slug: string; category: string; status: string } }
  expect(body.product).toMatchObject({ slug: 'peachy', category: 'adult', status: 'live' })
  return s
}

describe('the category itself', () => {
  test('inference can neither put a listing in Adult (18+) nor take one out', () => {
    const words = { tags: ['adult', 'porn', 'xxx', 'nsfw', '18+'], name: 'Adult XXX', tagline: 'adult content for adults', description: 'adult adult adult porn nsfw' }
    expect(categorize(words)).not.toContain('adult')
    expect(categorize({ ...words, category: null })).not.toContain('adult')
    // And a listing set to adult is adult alone, whatever its words say.
    expect(categorize({ tags: ['developer', 'api'], name: 'Dev tool', tagline: 'An SDK', description: '', category: 'adult' })).toEqual(['adult'])
    expect(CATEGORIES.some((c) => c.key === 'adult')).toBe(false)
    expect(CATEGORIES.length).toBe(21)
    expect(search([], parseQuery({ category: 'adult' })).query.category).toEqual(['adult'])
  })

  test('only "adult" is a category anyone can set', async () => {
    const { call } = setup()
    const r = await call('/api/v1/products', json({ url: 'plum.test', category: 'games' }, ADMIN))
    expect(r.status).toBe(400)
    expect(((await r.json()) as { field: string }).field).toBe('category')
  })
})

describe('anonymous visitors never see an adult listing', () => {
  test('lists, boards, search, suggestions, tags, categories, feed, sitemap, stats and the public API', async () => {
    const { call, store } = await seeded()
    expect(store.bySlug('peachy')!.category).toBe('adult')

    const pages = ['/', '/new', '/top/today', '/top/all', '/top/featured', '/search', '/search?q=peachy', '/search?q=studio', '/search?tag=peachtag', '/tags', '/c/other', '/leaderboard', '/feed.xml', '/sitemap.xml', '/llms.txt', '/robots.txt', '/submit', '/help']
    for (const path of pages) {
      const r = await call(path)
      const text = await r.text()
      expect(`${path} ${LEAK.test(text)}`).toBe(`${path} false`)
      expect(`${path} ${text.includes('Adult (18+)') && !['/submit', '/help'].includes(path)}`).toBe(`${path} false`)
    }
    // The public one is there, so the checks above are not passing on an empty board.
    expect(await (await call('/new')).text()).toContain('Acme')
    expect(await (await call('/sitemap.xml')).text()).toContain('/p/acme')
    expect(await (await call('/feed.xml')).text()).toContain('/p/acme')
    expect((await call('/t/peachtag')).status).toBe(404)
    expect((await call('/t/zebratag')).status).toBe(200)

    const apis = ['/api/v1/products?window=new&limit=100', '/api/v1/products?window=all', '/api/v1/products?window=today', '/api/v1/products?window=featured', '/api/v1/products?q=peachy', '/api/v1/products?tag=peachtag', '/api/v1/search', '/api/v1/search?q=peachy&facets=0', '/api/v1/search?tag=peachtag', '/api/v1/categories', '/api/v1/tags', '/api/v1/stats', '/api/v1/leaderboard']
    for (const path of apis) {
      const r = await call(path)
      const text = await r.text()
      expect(`${path} ${r.status}`).toBe(`${path} 200`)
      expect(`${path} ${LEAK.test(text) || /"adult"|Adult \(18\+\)/.test(text)}`).toBe(`${path} false`)
    }
    // What nichedb reads every hour.
    const fresh = (await (await call('/api/v1/products?window=new&limit=100')).json()) as { products: { slug: string; category: string | null }[] }
    expect(fresh.products.map((p) => p.slug)).toEqual(['acme'])
    expect(fresh.products[0]!.category).toBeNull()
    expect(((await (await call('/api/v1/stats')).json()) as { products: number }).products).toBe(1)
  })

  test('the listing, its machine files and the category answer with sign-in or 401, never 404, and are never indexed', async () => {
    const { call } = await seeded()
    for (const path of ['/p/peachy', '/c/adult', '/search?category=adult', '/search?category=adult&q=peachy', '/p/peachy/claim']) {
      const r = await call(path)
      expect(`${path} ${r.status}`).toBe(`${path} 302`)
      expect(r.headers.get('location')).toBe(`/login?next=${encodeURIComponent(path)}`)
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow')
      expect(await r.text()).not.toMatch(/peach/i)
    }
    for (const path of ['/p/peachy/opensite.json', '/p/peachy/openprofile.md', '/p/peachy/claim.md', '/api/v1/products/peachy', '/api/v1/products/peachy/comments', '/api/v1/products/peachy/reviews', '/api/v1/products?category=adult', '/api/v1/search?category=adult', '/api/v1/sites?url=peach.test']) {
      const r = await call(path)
      const text = await r.text()
      expect(`${path} ${r.status}`).toBe(`${path} 401`)
      expect(text).toContain('Adult (18+) category needs a signed-in account')
      expect(text).not.toMatch(/peach/i)
      expect(r.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    }
    // Writes too: a vote or a share from nobody is refused before it is counted.
    expect((await call('/api/v1/products/peachy/vote', json({}))).status).toBe(401)
    expect((await call('/p/peachy/vote', form({}))).headers.get('location')).toBe('/login?next=%2Fp%2Fpeachy%2Fvote')
    expect((await call('/p/peachy/share?net=x', json({}))).status).toBe(401)
    // A wrong key is nobody.
    expect((await call('/api/v1/products/peachy', { headers: { authorization: 'Bearer bi_nope' } })).status).toBe(401)
    // Posting its URL again does not hand the listing back.
    const again = await call('/api/v1/products', json({ url: 'peach.test' }))
    expect(again.status).toBe(401)
    expect(await again.text()).not.toMatch(/peachy/i)
  })

  test('the maker of only adult listings is gated too; the leaderboard never names the listing', async () => {
    const { call, store } = await seeded()
    const maker = store.bySlug('peachy')!.makerId!
    expect(maker).toBeTruthy()
    expect((await call(`/makers/${maker}`)).headers.get('location')).toBe(`/login?next=${encodeURIComponent(`/makers/${maker}`)}`)
    expect((await call(`/makers/${maker}/openprofile.md`)).status).toBe(401)
    expect((await call(`/api/v1/makers/${maker}`)).status).toBe(401)
    // A member's public name is their best public listing, never an adult one.
    const u = store.findOrCreateUser('owner@peach.test')
    store.claim(store.bySlug('peachy')!.id, u.id)
    expect(store.publicName(u.id)).not.toMatch(/peach/i)
  })

  test('the badge keeps working and shows nothing of the listing; /for sends a visitor to sign in', async () => {
    const { call } = await seeded()
    for (const path of ['/badge/peachy.svg', '/for.svg?site=peach.test', '/badge/peachy.svg?shape=square']) {
      const r = await call(path)
      const svg = await r.text()
      expect(`${path} ${r.status}`).toBe(`${path} 200`)
      expect(svg).toContain('built.indie')
      expect(svg).not.toMatch(/peach/i)
    }
    expect((await call('/for?site=peach.test')).headers.get('location')).toBe('/login?next=%2Fp%2Fpeachy')
    expect((await call('/for?site=acme.test')).headers.get('location')).toBe('/p/acme?ref=badge')
  })

  test('submitting to Adult (18+) needs an account, on the form and in the API', async () => {
    const { call, store } = setup()
    const web = await call('/submit', form({ url: 'plum.test', category: 'adult' }))
    expect(web.status).toBe(401)
    expect(await web.text()).toContain('Sign in to submit to the Adult (18+) category.')
    const api = await call('/api/v1/products', json({ url: 'plum.test', category: 'adult' }))
    expect(api.status).toBe(401)
    expect(((await api.json()) as { error: string; field: string }).field).toBe('category')
    expect(store.bySlug('plum')).toBeNull()
  })
})

describe('signed-in members', () => {
  test('see the category entry, the category page with the 18+ line once, and the listing; adult stays out of the general lists', async () => {
    const { call, signIn } = await seeded()
    const cookie = await signIn('member@example.com')
    const get = (path: string, extra = '') => call(path, { headers: { cookie: `${cookie}${extra}` } })

    // Still not mixed into home, boards, general search or tag pages.
    for (const path of ['/', '/new', '/top/all', '/search?q=peachy', '/search?tag=peachtag', '/tags', '/feed.xml', '/sitemap.xml']) expect(`${path} ${LEAK.test(await (await get(path)).text())}`).toBe(`${path} false`)
    expect((await get('/t/peachtag')).status).toBe(404)

    // The entry, where categories are listed.
    const rail = await (await get('/search')).text()
    expect(rail).toContain('Adult (18+)')
    expect(rail).toContain('/search?category=adult')

    const first = await get('/c/adult')
    const html = await first.text()
    expect(first.status).toBe(200)
    expect(first.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(html).toContain('Peachy')
    expect(html).not.toContain('Acme')
    expect(html).toContain('Adult content. You must be 18 or older.')
    expect(html).not.toContain('data-cp-ad')
    // Once per browser session.
    const seen = first.headers.get('set-cookie')!.split(';')[0]!
    expect(seen).toBe('bi_adult=1')
    expect(await (await get('/c/adult', `; ${seen}`)).text()).not.toContain('You must be 18 or older.')

    // Search inside the category.
    expect(await (await get('/search?category=adult&q=peachy')).text()).toContain('/p/peachy')
    expect(await (await get('/search?category=adult&q=acme')).text()).not.toContain('/p/acme')

    const listing = await get('/p/peachy')
    const page = await listing.text()
    expect(listing.status).toBe(200)
    expect(listing.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(page).toContain('<meta name="robots" content="noindex, nofollow">')
    expect(page).toContain('Adult (18+)')
    expect(page).not.toContain('og:image')
    expect(page).not.toContain('Share it')
    expect(page).not.toContain('Feature it')
    expect((await get('/p/peachy/opensite.json')).status).toBeLessThan(500)
    expect((await get('/p/peachy/openprofile.md')).status).toBe(200)
    // A vote from the gated page counts.
    expect((await call('/p/peachy/vote', form({}, { cookie, accept: 'application/json' }))).status).toBe(200)
  })

  test('the API and the client list adult listings only on an explicit category=adult', async () => {
    const { call, store } = await seeded()
    const key = store.newApiKey(store.findOrCreateUser('dev@example.com').id)
    const auth = { headers: { authorization: `Bearer ${key}` } }
    for (const path of ['/api/v1/products?window=new', '/api/v1/products?window=all', '/api/v1/products?q=peachy', '/api/v1/products?tag=peachtag', '/api/v1/search?q=peachy', '/api/v1/tags']) expect(`${path} ${LEAK.test(await (await call(path, auth)).text())}`).toBe(`${path} false`)

    const listed = await call('/api/v1/products?category=adult&window=new', auth)
    expect(listed.status).toBe(200)
    expect(listed.headers.get('x-robots-tag')).toBe('noindex, nofollow')
    expect(listed.headers.get('cache-control')).toBe('private, no-store')
    expect(((await listed.json()) as { products: { slug: string }[] }).products.map((p) => p.slug)).toEqual(['peachy'])

    const found = (await (await call('/api/v1/search?category=adult', auth)).json()) as { total: number; products: { slug: string; categories: string[] }[] }
    expect(found.products.map((p) => p.slug)).toEqual(['peachy'])
    expect(found.products[0]!.categories).toEqual(['adult'])

    const cats = (await (await call('/api/v1/categories', auth)).json()) as { categories: { key: string; label: string; count: number }[] }
    expect(cats.categories.find((c) => c.key === 'adult')).toMatchObject({ label: 'Adult (18+)', count: 1 })
    expect((await call('/api/v1/products/peachy', auth)).status).toBe(200)

    // The CLI and the MCP server go through this client.
    const client = new BuiltIndieClient('http://localhost', key, ((url: string, init?: RequestInit) => call(String(url).replace('http://localhost', ''), init)) as unknown as typeof fetch)
    expect((await client.list('new', 10)).products.map((p) => p.slug)).toEqual(['acme'])
    expect((await client.list('new', 10, 'adult')).products.map((p) => p.slug)).toEqual(['peachy'])
    expect((await client.search('', { category: ['adult'] })).products.map((p) => p.slug)).toEqual(['peachy'])
    const anon = new BuiltIndieClient('http://localhost', undefined, ((url: string, init?: RequestInit) => call(String(url).replace('http://localhost', ''), init)) as unknown as typeof fetch)
    await expect(anon.list('new', 10, 'adult')).rejects.toThrow('Adult (18+) category needs a signed-in account')
  })

  test('a member submits to Adult (18+): a draft, then live in the category and nowhere public; it cannot be featured', async () => {
    const { call, signIn, store, service } = setup()
    const cookie = await signIn('maker@example.com')
    expect(await (await call('/submit', { headers: { cookie } })).text()).toContain('name="category"')
    const made = await call('/submit', form({ url: 'peach.test', category: 'adult' }, { cookie }))
    expect(made.headers.get('location')).toBe('/p/peachy/edit?fresh=1')
    const slug = 'peachy'
    expect(store.bySlug(slug)).toMatchObject({ status: 'draft', category: 'adult' })
    await call(`/p/${slug}/edit`, form({ action: 'publish', name: 'Peachy' }, { cookie }))
    expect(store.bySlug(slug)).toMatchObject({ status: 'live', category: 'adult' })
    expect(await (await call('/new')).text()).not.toMatch(/peach/i)
    expect(await (await call('/c/adult', { headers: { cookie } })).text()).toContain('Peachy')

    const p = store.bySlug(slug)!
    const user = store.userByEmail('maker@example.com')!
    await expect(service.feature(p, { email: 'maker@example.com' })).rejects.toThrow('cannot be featured')
    expect(() => service.redeemCredit(p, user)).toThrow('cannot be featured')
    await expect(service.spendFeaturedDays(p, user, 1)).rejects.toThrow('cannot be featured')
    expect((await call(`/p/${slug}/feature`, form({ email: 'maker@example.com' }, { cookie }))).status).toBe(400)
    expect(await (await call('/top/featured')).text()).not.toMatch(/peach/i)

    // Its owner may put a listing in, but only staff take one out.
    const key = store.newApiKey(user.id)
    const out = await call(`/api/v1/products/${slug}`, json({ category: null }, { authorization: `Bearer ${key}` }, 'PATCH'))
    expect(out.status).toBe(400)
    expect(store.bySlug(slug)!.category).toBe('adult')
  })
})

describe('staff', () => {
  test('move a listing in and out of the category with the admin key', async () => {
    const { call, store } = setup()
    await call('/submit', form({ url: 'acme.test' }))
    expect(await (await call('/new')).text()).toContain('Acme')
    const into = await call('/api/v1/products/acme', json({ category: 'adult' }, ADMIN, 'PATCH'))
    expect(into.status).toBe(200)
    expect(store.bySlug('acme')!.category).toBe('adult')
    expect(await (await call('/new')).text()).not.toContain('Acme')
    expect((await call('/p/acme')).status).toBe(302)
    expect(((await (await call('/api/v1/search')).json()) as { total: number }).total).toBe(0)

    expect((await call('/api/v1/products/acme', json({ category: null }, ADMIN, 'PATCH'))).status).toBe(200)
    expect(store.bySlug('acme')!.category).toBeNull()
    expect(await (await call('/new')).text()).toContain('Acme')
    expect((await call('/p/acme')).status).toBe(200)
    // Re-posting a live listing's URL with the category moves it too (a bulk import over an existing listing).
    const re = await call('/api/v1/products', json({ url: 'acme.test', category: 'adult' }, ADMIN))
    expect(((await re.json()) as { existing: boolean; product: { category: string } }).product.category).toBe('adult')
    // Nobody else can.
    expect((await call('/api/v1/products/acme', json({ category: null }, {}, 'PATCH'))).status).toBe(401)
  })

  test('seed a listing whose homepage will not be read, from the name, description and tags given', async () => {
    const { call, store } = setup()
    const r = await call('/api/v1/products', json({ url: 'walled.test', category: 'adult', name: 'Walled Garden', description: 'Behind an age gate.', tags: ['vr', '4k'] }, ADMIN))
    expect(r.status).toBe(201)
    expect(store.bySlug('walled-garden')).toMatchObject({ status: 'live', category: 'adult', name: 'Walled Garden', description: 'Behind an age gate.', tags: ['vr', '4k'], logo: null, screenshot: null })
    // Only staff get that: anyone else is told the site could not be read.
    expect((await call('/api/v1/products', json({ url: 'walled.test/x', name: 'Walled' }))).status).toBe(400)
    expect(await (await call('/new')).text()).not.toContain('Walled')
  })

  test('the launch mail goes to the submitter alone, and says where the listing is', async () => {
    process.env.CROSS_PROMO = 'bundled'
    const { call, signIn, mail } = setup()
    const cookie = await signIn('maker@example.com')
    await call('/submit', form({ url: 'peach.test', category: 'adult' }, { cookie }))
    const before = mail.length
    await call('/p/peachy/edit', form({ action: 'publish', name: 'Peachy' }, { cookie }))
    await new Promise((r) => setTimeout(r, 50))
    const sent = mail.slice(before)
    expect(sent.map((m) => m.to)).toEqual(['maker@example.com'])
    expect(sent[0]!.subject).toBe('Peachy is live on built.indie')
    expect(sent[0]!.text).toContain('in the Adult (18+) category')
    expect(sent[0]!.text).toContain('/c/adult')
    expect(sent[0]!.text).not.toContain('Share it to climb')
  })
})
