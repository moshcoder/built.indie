import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth, type Mail } from '../src/auth.ts'
import { main } from '../src/cli.ts'
import { BuiltIndieClient } from '../src/client.ts'
import { Store, type Product } from '../src/db.ts'
import { Media } from '../src/media.ts'
import { createApp } from '../src/server.ts'
import { BuiltIndie } from '../src/service.ts'
import { initialState, onKey } from '../src/tui.ts'

function setup(perCredit = 500) {
  const dir = mkdtempSync(join(tmpdir(), 'builtindie-karma-'))
  const store = new Store(join(dir, 'test.db'), 'x'.repeat(32))
  const service = new BuiltIndie(store, new Media(join(dir, 'media')), { origin: 'https://built.indie.pit.world', coinpay: null, featureUsd: 19, featureDays: 7, screenshots: false, karmaPerCredit: perCredit })
  const mail: Mail[] = []
  const app = createApp({ service, auth: new Auth(store, async (m) => void mail.push(m)), adminKey: 'admin-key-0123456789', secureCookies: false, mailer: async (m) => void mail.push(m) })
  const call = (path: string, init: RequestInit = {}, ip = '1.2.3.4') => app.fetch(new Request(`http://localhost${path}`, init), { ip })
  let n = 0
  /** A listing straight into the store: no network. */
  const listing = (owner: string | null, o: Partial<Product> = {}): Product => {
    n++
    return store.create({ id: `id${n}`, slug: `app-${n}`, url: `https://app${n}.test/`, domain: `app${n}.test`, name: `App ${n}`, tagline: 'An app', description: '', logo: null, ogImage: null, screenshot: null, images: [], videos: [], socials: {}, tags: [], themeColor: null, llms: null, profile: null, record: null, extras: { stack: null, pricing: null, openicon: null }, makerName: '', makerProfile: null, submitterUser: owner, status: 'live', ...o }, 'test')
  }
  const user = (email: string) => store.findOrCreateUser(email)
  const signIn = async (email: string) => {
    await call('/login', form({ email }))
    const token = mail.at(-1)!.text.match(/token=([\w-]+)/)![1]!
    return (await call(`/auth/verify?token=${token}`)).headers.get('set-cookie')!.split(';')[0]!
  }
  return { store, service, karma: service.karma, app, call, mail, listing, user, signIn }
}

const form = (data: Record<string, string>, cookie = '') => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin', ...(cookie ? { cookie } : {}) }, body: new URLSearchParams(data).toString() })
const json = (data: unknown, key?: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(data) })

describe('the karma ledger', () => {
  test('dedupe: a retry, a second click or a second address never pays twice', () => {
    const { store, service, listing, user } = setup()
    const maker = user('maker@example.com')
    const ann = user('ann@example.com')
    const p = listing(maker.id)
    expect(store.addKarma({ userId: ann.id, action: 'x', ref: 'r', points: 3, dedupe: 'k1' })).toBe(true)
    expect(store.addKarma({ userId: ann.id, action: 'x', ref: 'r', points: 3, dedupe: 'k1' })).toBe(false)
    expect(store.karmaTotal(ann.id)).toBe(3)
    // Ann votes from two addresses: the board counts two visitors, karma pays once.
    expect(service.vote(p, store.voterFor('1.1.1.1'), ann)).toBe(true)
    expect(service.vote(p, store.voterFor('1.1.1.1'), ann)).toBe(false)
    expect(service.vote(p, store.voterFor('2.2.2.2'), ann)).toBe(true)
    expect(store.karmaTotal(ann.id)).toBe(3 + 1)
    expect(store.karmaTotal(maker.id)).toBe(1)
    // The vote remembers who cast it.
    expect(store.db.query('SELECT COUNT(*) AS n FROM votes WHERE user_id = ?').get(ann.id)).toEqual({ n: 2 })
    // Anonymous votes still count and earn nobody anything.
    expect(service.vote(p, store.voterFor('3.3.3.3'), null)).toBe(true)
    expect(store.product(p.id)!.votes).toBe(3)
    expect(store.karmaTotal(maker.id)).toBe(1)
  })

  test('daily caps: 20 paid votes, 10 paid comments, 5 paid shares; the actions still work after', () => {
    const { store, service, listing, user } = setup()
    const maker = user('maker@example.com')
    const ann = user('ann@example.com')
    const ps = Array.from({ length: 22 }, () => listing(maker.id))
    for (const p of ps) expect(service.vote(p, store.voterFor('9.9.9.9'), ann)).toBe(true)
    expect(store.karmaTotal(ann.id)).toBe(20)
    // The owner's received upvotes are not capped.
    expect(store.karmaTotal(maker.id)).toBe(22)
    const before = store.karmaTotal(ann.id)
    for (let i = 0; i < 12; i++) service.comment(ps[i]!, ann, `A thoughtful comment number ${i}`)
    expect(store.karmaTotal(ann.id) - before).toBe(10 * 2)
    expect(store.comments(ps[11]!.id)).toHaveLength(1)
    const mid = store.karmaTotal(ann.id)
    // Once per listing per network per day; five a day.
    expect(service.share(ps[0]!, ann, 'x').counted).toBe(true)
    expect(service.share(ps[0]!, ann, 'x').counted).toBe(false)
    for (const net of ['bluesky', 'linkedin', 'reddit', 'hn', 'mastodon', 'copy']) service.share(ps[0]!, ann, net)
    expect(store.karmaTotal(ann.id) - mid).toBe(5)
    expect(() => service.share(ps[0]!, ann, 'myspace')).toThrow()
    // Short comments post but earn nothing.
    const other = user('other@example.com')
    service.comment(ps[0]!, other, 'nice')
    expect(store.karmaTotal(other.id)).toBe(0)
  })

  test('self-dealing earns nothing: votes, reviews, comments and shares on your own listing', () => {
    const { store, service, listing, user } = setup()
    const maker = user('maker@example.com')
    const p = listing(maker.id)
    service.vote(p, store.voterFor('1.1.1.1'), maker)
    service.comment(p, maker, 'Thanks everyone for the kind words!')
    service.review(p, maker, 5, 'This is the best product I have ever made, truly.')
    service.share(p, maker, 'x')
    expect(store.karmaTotal(maker.id)).toBe(0)
    // A claimed listing: the owner is self too, and gets the received karma.
    const ann = user('ann@example.com')
    const q = listing(null)
    store.claim(q.id, ann.id)
    const claimed = store.product(q.id)!
    service.vote(claimed, store.voterFor('1.1.1.1'), ann)
    expect(store.karmaTotal(ann.id)).toBe(0)
    const bob = user('bob@example.com')
    service.review(claimed, bob, 4, 'Solid little tool that does what it says it does.')
    expect(store.karmaTotal(bob.id)).toBe(5)
    expect(store.karmaTotal(ann.id)).toBe(2)
    // A review needs 30 characters to pay; editing it longer pays once, then never again.
    const cat = user('cat@example.com')
    service.review(claimed, cat, 3, 'meh')
    expect(store.karmaTotal(cat.id)).toBe(0)
    service.review(claimed, cat, 4, 'Grew on me after a week of daily use, honestly.')
    service.review(claimed, cat, 5, 'Grew on me after a week of daily use, honestly!!')
    expect(store.karmaTotal(cat.id)).toBe(5)
    expect(store.product(q.id)).toMatchObject({ reviews: 2, rating: 4.5 })
    expect(() => service.review(claimed, cat, 6, 'x')).toThrow()
    // Deleting the review takes back both sides; a new one pays nothing again.
    service.deleteReview(claimed, cat.id)
    expect(store.karmaTotal(cat.id)).toBe(0)
    expect(store.karmaTotal(ann.id)).toBe(2)
    service.review(claimed, cat, 5, 'Grew on me after a week of daily use, honestly!!')
    expect(store.karmaTotal(cat.id)).toBe(0)
  })

  test('deleting a comment reverses its points, once; replies stay', () => {
    const { store, service, listing, user } = setup()
    const p = listing(user('maker@example.com').id)
    const ann = user('ann@example.com')
    const bob = user('bob@example.com')
    const c = service.comment(p, ann, 'How does the sync work offline?')
    const r = service.comment(p, bob, 'Same question here, curious too.', c.id)
    // A reply to a reply joins the thread one level down.
    const rr = service.comment(p, ann, 'Thanks Bob, waiting on the maker.', r.id)
    expect(rr.parentId).toBe(c.id)
    expect(store.karmaTotal(ann.id)).toBe(4)
    expect(() => service.deleteComment(c.id, bob)).toThrow('Only its author')
    service.deleteComment(c.id, ann)
    expect(store.karmaTotal(ann.id)).toBe(2)
    expect(() => service.deleteComment(c.id, ann)).toThrow()
    expect(store.reverseKarma(`comment:${c.id}`, 'comment_deleted')).toBeNull()
    expect(store.karmaTotal(ann.id)).toBe(2)
    // The deleted comment keeps its place (it has replies) without its words.
    const thread = store.comments(p.id)
    expect(thread.find((x) => x.id === c.id)).toMatchObject({ body: '' })
    expect(thread.filter((x) => x.parentId === c.id)).toHaveLength(2)
    // The ledger only grows: the original row is still there, the reversal is a new one.
    expect(store.karmaEvents(ann.id).map((e) => e.points).sort()).toEqual([-2, 2, 2])
    // The admin deletes too.
    service.deleteComment(r.id, null, true)
    expect(store.karmaTotal(bob.id)).toBe(0)
  })

  test('credits: each milestone grants one free Featured week, never twice, and spends like an invite credit', () => {
    const { store, karma, service, listing, user } = setup(10)
    const ann = user('ann@example.com')
    const credits: number[] = []
    karma.onCredit = (_u, n) => void credits.push(n)
    const mine = listing(ann.id)
    // +10 for launching crosses the first milestone.
    service.publish(mine)
    expect(store.karmaTotal(ann.id)).toBe(10)
    expect(credits).toEqual([1])
    expect(store.inviteStats(ann.id)).toMatchObject({ credits: 1, karmaCredits: 1 })
    // Publishing again pays nothing.
    service.publish(store.product(mine.id)!)
    expect(store.karmaTotal(ann.id)).toBe(10)
    // Drop below and climb back: the milestone is not paid again.
    const maker = user('maker@example.com')
    const other = listing(maker.id)
    const c = service.comment(other, ann, 'A comment long enough to pay.')
    service.deleteComment(c.id, ann)
    store.addKarma({ userId: ann.id, action: 'test', ref: '', points: -5, dedupe: 'dip' })
    store.addKarma({ userId: ann.id, action: 'test', ref: '', points: 5, dedupe: 'up' })
    expect(store.grantKarmaCredits(ann.id, 10)).toBe(0)
    expect(karma.summary(ann.id)).toMatchObject({ total: 10, nextCreditIn: 10, credits: { granted: 1, used: 0 } })
    // A jump over two milestones grants both.
    store.addKarma({ userId: ann.id, action: 'test', ref: '', points: 20, dedupe: 'big' })
    expect(store.grantKarmaCredits(ann.id, 10)).toBe(2)
    expect(store.inviteStats(ann.id).credits).toBe(3)
    // Spent through the same path as an invite credit.
    expect(service.redeemCredit(mine, ann).featuredUntil!).toBeGreaterThan(Date.now())
    expect(store.inviteStats(ann.id)).toMatchObject({ credits: 2, karmaCredits: 2, used: 1 })
  })

  test('launch, claim, badge and invite pay once per listing; admin imports and takedowns pay nothing', async () => {
    const { store, service, karma, call, listing, user } = setup()
    const ann = user('ann@example.com')
    const draft = listing(ann.id, { status: 'draft' })
    service.publish(draft)
    expect(store.karmaTotal(ann.id)).toBe(10)
    expect(karma.claimed(store.product(draft.id)!, ann.id)).toBe(true)
    expect(karma.claimed(store.product(draft.id)!, ann.id)).toBe(false)
    expect(karma.badgeVerified(store.product(draft.id)!)).toBe(true)
    expect(karma.badgeVerified(store.product(draft.id)!)).toBe(false)
    expect(karma.inviteConverted(ann.id, 'someone-else')).toBe(true)
    expect(store.karmaTotal(ann.id)).toBe(10 + 5 + 5 + 25)
    // A listing with no member behind it (anonymous, or the admin bearer's import) pays nobody.
    expect(karma.launched(listing(null))).toBe(false)
    // An admin takedown takes back what the listing paid.
    await call(`/api/v1/products/${draft.slug}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-key-0123456789' } })
    expect(store.karmaTotal(ann.id)).toBe(25)
  })
})

describe('karma on the site', () => {
  test('comments, reviews, shares and votes from the web; product page, /me, leaderboard, API, CLI, MCP-facing client', async () => {
    const { store, call, listing, user, signIn } = setup()
    const maker = user('maker@example.com')
    store.setDisplayName(maker.id, 'Mia Maker')
    const p = listing(maker.id)
    const ann = await signIn('ann@example.com')
    const annId = store.userByEmail('ann@example.com')!.id
    store.setDisplayName(annId, 'Ann <b>Bold</b>')
    // Signed out: forms say sign in; posting goes to the login page.
    expect(await (await call(`/p/${p.slug}`)).text()).toContain('to comment')
    expect((await call(`/p/${p.slug}/comments`, form({ body: 'hello there everyone' }))).headers.get('location')).toContain('/login')
    // Ann comments (escaped), reviews and votes.
    const posted = await call(`/p/${p.slug}/comments`, form({ body: 'Love it <script>alert(1)</script> great work' }, ann))
    expect(posted.status).toBe(302)
    expect(posted.headers.get('location')).toMatch(new RegExp(`/p/${p.slug}#c-`))
    await call(`/p/${p.slug}/review`, form({ rating: '4', body: 'Does exactly what it says and is fast too.' }, ann))
    await call(`/p/${p.slug}/vote`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', accept: 'application/json', cookie: ann } })
    // Cross-site posts do nothing.
    await call(`/p/${p.slug}/comments`, { ...form({ body: 'from elsewhere, sneaky' }, ann), headers: { ...form({}, ann).headers, 'sec-fetch-site': 'cross-site' } })
    expect(store.comments(p.id)).toHaveLength(1)
    // Share beacon.
    expect(await (await call(`/p/${p.slug}/share?net=bluesky`, { method: 'POST', headers: { 'sec-fetch-site': 'same-origin', cookie: ann } })).json()).toEqual({ counted: true })
    expect((await call(`/p/${p.slug}/share?net=nope`, { method: 'POST', headers: { cookie: ann } })).status).toBe(400)
    expect(store.karmaTotal(annId)).toBe(2 + 5 + 1 + 1)
    expect(store.karmaTotal(maker.id)).toBe(2 + 1)
    const page = await (await call(`/p/${p.slug}`, { headers: { cookie: ann } })).text()
    expect(page).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(page).not.toContain('<script>alert(1)')
    expect(page).toContain('Ann &lt;b&gt;Bold&lt;/b&gt;')
    expect(page).toContain('9 karma')
    expect(page).toContain('id="reviews"')
    expect(page).toContain('"aggregateRating"')
    expect(page).toContain('data-share="bluesky"')
    expect(page).toContain('Update review')
    expect(page).not.toContain('ann@example.com')
    // Cards show the rating.
    expect(await (await call('/new')).text()).toContain('★ 4.0')
    // /me: karma, history, progress, how to earn.
    const me = await (await call('/me', { headers: { cookie: ann } })).text()
    expect(me).toContain('id="karma"')
    expect(me).toContain('491 karma</b> to your next free Featured week')
    expect(me).toContain('Reviewed a launch')
    expect(me).toContain('How to earn karma')
    // The leaderboard: karma by default, inviters one tab over; the homepage widget.
    const lb = await (await call('/leaderboard')).text()
    expect(lb).toContain('data-board="karma"')
    expect(lb).toContain('How to earn karma')
    expect(await (await call('/leaderboard?board=invites')).text()).toContain('data-board="invites"')
    const top = await (await call('/api/v1/leaderboard?board=karma&period=week')).json()
    expect(top.rows[0]).toMatchObject({ rank: 1, name: 'Ann <b>Bold</b>', value: 9 })
    expect(top.rows[0].badges.map((b: { id: string }) => b.id)).toEqual(expect.arrayContaining(['number-one', 'top-ten-week']))
    expect(top.rows[0].badges.map((b: { id: string }) => b.id)).not.toContain('first-karma')
    expect((await (await call('/leaderboard/karma.json?period=week')).json()).rows).toHaveLength(2)
    const home = await (await call('/')).text()
    expect(home).toContain('Top karma this week')
    expect(home).toContain('9 karma')
    // Ann deletes her comment: the points go back.
    const cid = store.comments(p.id)[0]!.id
    await call(`/p/${p.slug}/comments/${cid}/delete`, form({}, ann))
    expect(store.karmaTotal(annId)).toBe(7)
    // The API, CLI and the client the MCP server uses.
    const key = store.newApiKey(annId)
    expect((await call('/api/v1/karma')).status).toBe(401)
    const k = await (await call('/api/v1/karma', { headers: { authorization: `Bearer ${key}` } })).json()
    expect(k).toMatchObject({ total: 7, per_credit: 500, next_credit_in: 493 })
    expect(k.events[0].action).toBe('comment_deleted')
    const made = await call(`/api/v1/products/${p.slug}/comments`, json({ body: 'Posting from the API works fine.' }, key))
    expect(made.status).toBe(201)
    const client = new BuiltIndieClient('http://localhost', key, ((u: string, i: RequestInit) => call(new URL(u).pathname + new URL(u).search, i)) as unknown as typeof fetch)
    const lines: string[] = []
    const out = { log: (t: string) => lines.push(t), error: (t: string) => lines.push(t) }
    expect(await main(['karma'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('9 karma')
    expect(await main(['comment', p.slug, 'A comment from the terminal, hello!'], out, client)).toBe(0)
    expect(await main(['comments', p.slug], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('A comment from the terminal')
    expect(await main(['review', p.slug, '5', 'Changed my mind, five stars from me now.'], out, client)).toBe(0)
    expect(await main(['reviews', p.slug], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('★ 5 from 1')
    expect(await main(['leaderboard'], out, client)).toBe(0)
    expect(lines.at(-1)).toContain('Top karma')
    // Past 10 karma: the badge is awarded on the write (a projection is never record()ed).
    const after = await (await call('/api/v1/leaderboard?board=karma')).json()
    expect(after.rows[0]).toMatchObject({ value: 11 })
    expect(after.rows[0].badges.map((b: { id: string }) => b.id)).toContain('first-karma')
    const comments = await client.comments(p.slug)
    expect(comments.comments.every((c) => !JSON.stringify(c).includes('@example.com'))).toBe(true)
    // An admin deletes a comment over the API; someone else's key cannot.
    const bobKey = store.newApiKey(user('bob@example.com').id)
    const victim = comments.comments.at(-1)!.id
    expect((await call(`/api/v1/comments/${victim}`, { method: 'DELETE', headers: { authorization: `Bearer ${bobKey}` } })).status).toBe(400)
    expect((await call(`/api/v1/comments/${victim}`, { method: 'DELETE', headers: { authorization: 'Bearer admin-key-0123456789' } })).status).toBe(200)
    // llms.txt and the help page document it.
    expect(await (await call('/llms.txt')).text()).toContain('/api/v1/karma')
    expect(await (await call('/help')).text()).toContain('id="karma"')
  })

  test('the TUI opens the karma board with k and closes it with Esc', () => {
    const s = initialState()
    expect(onKey(s, { name: 'k', key: 'k', char: 'k' })).toBe('karma')
    s.board = { board: 'karma', period: 'week', total: 0, rows: [], web: '' }
    expect(onKey(s, { name: 'down', key: 'down' })).toBeNull()
    expect(onKey(s, { name: 'escape', key: 'escape' })).toBeNull()
    expect(s.board).toBeNull()
  })
})
