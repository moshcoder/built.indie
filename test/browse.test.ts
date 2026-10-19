import { describe, expect, test } from 'bun:test'
import { categorize, parseQuery, queryString, search, toggle } from '../src/browse.ts'
import type { Product } from '../src/db.ts'

const NOW = Date.parse('2026-10-19T12:00:00Z')
const DAY = 86400_000

let n = 0
function product(o: Partial<Product>): Product {
  n += 1
  return {
    id: `p${n}`, slug: `p${n}`, url: `https://p${n}.test/`, domain: `p${n}.test`, name: `P${n}`, tagline: '', description: '',
    logo: null, ogImage: null, screenshot: null, images: [], videos: [], socials: {}, tags: [], themeColor: null, llms: null, profile: null, record: null,
    extras: { stack: null, pricing: null, openicon: null }, makerName: '', makerProfile: null, makerId: null, makerVerified: false, ownerId: null, claimedAt: null,
    submitterUser: null, status: 'live', votes: 0, verifiedAt: null, featuredUntil: null, launchedAt: NOW - DAY / 2, createdAt: NOW, updatedAt: NOW,
    ...o,
  }
}

const coinpay = product({ name: 'CoinPay', tagline: 'Crypto Payment Gateway', tags: ['cryptocurrency', 'payment gateway'], votes: 9, verifiedAt: NOW, makerName: 'Profullstack', launchedAt: NOW - 40 * DAY })
const hqtui = product({ name: 'hqtui', tagline: 'Terminal UI for TypeScript', description: 'A TUI toolkit for developers.', tags: ['developer'], votes: 4, makerName: 'Profullstack', extras: { stack: { url: 'x', items: [{ layer: 'Runtime', name: 'Bun' }] }, pricing: null, openicon: null } })
const genre = product({ name: 'genrewatch', tagline: 'Know before it drops.', description: 'New music releases in the genres you follow.', tags: ['music'], votes: 6, videos: [{ kind: 'youtube', url: 'y', embed: 'e' }] })
const odd = product({ name: 'Zed', tagline: 'Two operatives.', description: 'Nothing to see.' })
const all = [coinpay, hqtui, genre, odd]

describe('categories', () => {
  test('tags and tagline file a launch; nothing known files it under other', () => {
    expect(categorize(coinpay)).toEqual(expect.arrayContaining(['crypto', 'finance']))
    expect(categorize(hqtui)[0]).toBe('developer-tools')
    expect(categorize(genre)).toEqual(['music'])
    expect(categorize(product({ name: 'Plain', tagline: 'Nothing here' }))).toEqual(['other'])
  })
  test('a single passing mention in the description does not add a category', () => {
    expect(categorize(product({ name: 'Bandly', tagline: 'Find bands', tags: ['music'], description: 'We take payments too.' }))).toEqual(['music'])
  })
})

describe('search', () => {
  test('words must all match; the name ranks first', () => {
    const r = search(all, parseQuery({ q: 'crypto payment' }), { now: NOW })
    expect(r.products.map((p) => p.name)).toEqual(['CoinPay'])
    expect(search(all, parseQuery({ q: 'hqtui' }), { now: NOW }).products[0]!.name).toBe('hqtui')
    expect(search(all, parseQuery({ q: 'nonsense words' }), { now: NOW }).total).toBe(0)
  })

  test('facets: OR within one, AND across, each counted without its own filter', () => {
    const q = parseQuery(new URLSearchParams('category=music&category=developer-tools'))
    const r = search(all, q, { now: NOW })
    expect(r.products.map((p) => p.name).sort()).toEqual(['genrewatch', 'hqtui'])
    // The category facet still shows crypto, as if it were not selected.
    expect(r.facets.category.find((f) => f.value === 'crypto')?.count).toBe(1)
    // Other facets count only what the category filter allows.
    expect(r.facets.maker).toEqual([{ value: 'Profullstack', label: 'Profullstack', count: 1 }])

    const both = search(all, parseQuery(new URLSearchParams('maker=Profullstack&has=verified')), { now: NOW })
    expect(both.products.map((p) => p.name)).toEqual(['CoinPay'])
    expect(both.facets.has.find((f) => f.value === 'verified')?.count).toBe(1)
  })

  test('launched, stack, has video, sort and chips', () => {
    expect(search(all, parseQuery({ launched: 'week' }), { now: NOW }).total).toBe(3)
    expect(search(all, parseQuery({ stack: 'Bun' }), { now: NOW }).products.map((p) => p.name)).toEqual(['hqtui'])
    expect(search(all, parseQuery({ has: 'video' }), { now: NOW }).products.map((p) => p.name)).toEqual(['genrewatch'])
    expect(search(all, parseQuery({ sort: 'name' }), { now: NOW }).products.map((p) => p.name)).toEqual(['CoinPay', 'genrewatch', 'hqtui', 'Zed'])
    expect(search(all, parseQuery({}), { now: NOW }).products[0]!.name).toBe('CoinPay')
    const r = search(all, parseQuery({ q: 'x', tag: 'music' }), { now: NOW })
    expect(r.chips.map((c) => c.label)).toEqual(['“x”', '#music'])
  })

  test('paging', () => {
    const r = search(all, parseQuery({ page: '2' }), { now: NOW, limit: 3 })
    expect(r.total).toBe(4)
    expect(r.products).toHaveLength(1)
  })
})

describe('query strings', () => {
  test('round trip, toggle, and unknown values dropped', () => {
    const q = parseQuery(new URLSearchParams('q=crm&category=ai,bogus&has=verified&has=nope&launched=forever&sort=new'))
    expect(q.category).toEqual(['ai'])
    expect(q.has).toEqual(['verified'])
    expect(q.launched).toBeNull()
    expect(queryString(q)).toBe('q=crm&category=ai&has=verified&sort=new')
    expect(queryString(toggle(q, 'category', 'ai'))).toBe('q=crm&has=verified&sort=new')
    expect(queryString(toggle(q, 'launched', 'week'))).toContain('launched=week')
    expect(parseQuery({}).sort).toBe('top')
    expect(parseQuery({ q: 'a' }).sort).toBe('relevance')
    expect(parseQuery({ sort: 'relevance' }).sort).toBe('top')
  })
})
