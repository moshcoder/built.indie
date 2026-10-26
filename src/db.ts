/**
 * built.indie's state: one SQLite file (pictures live beside it, see media.ts).
 *
 * A product is a URL someone launched. Anyone may launch any URL, signed in or
 * not: it is free. Who may change it afterwards:
 *   - its owner: whoever claimed it by putting our TXT record in the domain's DNS;
 *   - until then, the signed-in person who submitted it.
 * An account is an email address (magic link, auth.ts). A vote is one per
 * visitor per product, the visitor being a keyed hash of their address.
 */
import { Database } from 'bun:sqlite'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { Pricing, Profile, Stack, Video } from './fetch.js'
import { inferTags } from './tags.js'

/** What a product says about itself in the other LogicSRC files: OpenStack.md, OpenSaaS, OpenIcon. */
export type Extras = { stack: Stack | null; pricing: Pricing | null; openicon: string | null }

export type Status = 'draft' | 'live' | 'hidden'

export type Product = {
  id: string
  slug: string
  url: string
  domain: string
  name: string
  tagline: string
  description: string
  logo: string | null
  ogImage: string | null
  screenshot: string | null
  images: string[]
  videos: Video[]
  socials: Record<string, string>
  tags: string[]
  themeColor: string | null
  llms: { url: string; title: string; summary: string } | null
  profile: Profile | null
  record: Record<string, unknown> | null
  extras: Extras
  makerName: string
  makerProfile: string | null
  makerId: string | null
  makerVerified: boolean
  ownerId: string | null
  claimedAt: number | null
  submitterUser: string | null
  status: Status
  votes: number
  /** Reviews: how many, and the mean of their 1-5 stars (null with none). */
  reviews: number
  rating: number | null
  verifiedAt: number | null
  featuredUntil: number | null
  launchedAt: number | null
  createdAt: number
  updatedAt: number
}

export type User = { id: string; email: string; createdAt: number; displayName: string | null }

/** Where a member stands in the invite program. A credit is one Featured week, free. */
export type InviteStats = { code: string; invited: number; launched: number; credits: number; used: number; /** Of `credits`, how many came from karma (one per KARMA_PER_CREDIT). */ karmaCredits: number }

/** One row of the karma ledger. Points may be negative: a reversal is a new row, never an edit. */
export type KarmaEvent = { id: string; userId: string; action: string; ref: string; points: number; createdAt: number }

/** A comment on a listing. Threaded one level: a reply's parent is always a top-level comment. */
export type Comment = { id: string; productId: string; userId: string; parentId: string | null; body: string; createdAt: number; deletedAt: number | null }

/** One member's review of a listing: 1-5 stars and some words. One per member per listing. */
export type Review = { productId: string; userId: string; rating: number; body: string; createdAt: number; updatedAt: number }

export type Maker = { id: string; name: string; profileUrl: string; headline: string; avatar: string | null; web: string | null; accounts: string[]; createdAt: number }

export type Window = 'today' | 'week' | 'month' | 'all' | 'new' | 'featured'

export const hashKey = (key: string) => createHash('sha256').update(key).digest('hex')
export const newId = (bytes = 9) => randomBytes(bytes).toString('base64url')
export const makerIdFor = (profileUrl: string) => createHash('sha256').update(profileUrl.toLowerCase()).digest('base64url').slice(0, 10)

/** Paths that are pages, never product slugs. */
const RESERVED = new Set(['submit', 'new', 'top', 'api', 'm', 'p', 'b', 'makers', 'help', 'about', 'feed', 'badge', 'hooks', 'health', 'ring', 'well-known', 'admin', 'today', 'week', 'month', 'all', 'featured', 'edit', 'i', 'invite', 'leaderboard', 't', 'tags'])

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return s.length >= 2 && !RESERVED.has(s) ? s : `product-${s || newId(3).toLowerCase()}`
}

/** The day a timestamp falls on, UTC, as 2026-10-19. Launch days are UTC days. */
export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const startOfDay = (ms: number) => Date.parse(`${dayOf(ms)}T00:00:00Z`)

export class Store {
  readonly db: Database
  constructor(path: string, private readonly secret: string) {
    if (!secret || secret.length < 16) throw new Error('BUILTINDIE_KEY must be set (32 random bytes, hex)')
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        url_key TEXT NOT NULL,
        domain TEXT NOT NULL,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        logo TEXT,
        og_image TEXT,
        screenshot TEXT,
        images TEXT NOT NULL DEFAULT '[]',
        videos TEXT NOT NULL DEFAULT '[]',
        socials TEXT NOT NULL DEFAULT '{}',
        tags TEXT NOT NULL DEFAULT '[]',
        theme_color TEXT,
        llms TEXT,
        profile TEXT,
        record TEXT,
        extras TEXT,
        maker_name TEXT NOT NULL DEFAULT '',
        maker_profile TEXT,
        maker_id TEXT,
        maker_verified INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'draft',
        votes INTEGER NOT NULL DEFAULT 0,
        owner_id TEXT,
        claimed_at INTEGER,
        submitter_user TEXT,
        submitter TEXT NOT NULL DEFAULT '',
        verified_at INTEGER,
        featured_until INTEGER,
        launched_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS products_launched ON products(status, launched_at DESC);
      CREATE INDEX IF NOT EXISTS products_url ON products(url_key);
      CREATE INDEX IF NOT EXISTS products_maker ON products(maker_id);
      CREATE INDEX IF NOT EXISTS products_owner ON products(owner_id);
      CREATE INDEX IF NOT EXISTS products_submitter ON products(submitter_user);
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS magic_links (token_hash TEXT PRIMARY KEY, email TEXT NOT NULL, next TEXT, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS magic_links_email ON magic_links(email, created_at);
      CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS votes (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        voter TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, voter)
      );
      CREATE INDEX IF NOT EXISTS votes_time ON votes(created_at);
      CREATE TABLE IF NOT EXISTS makers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_url TEXT NOT NULL UNIQUE,
        headline TEXT NOT NULL DEFAULT '',
        avatar TEXT,
        web TEXT,
        accounts TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS badge_ids (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        UNIQUE (product_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS invite_codes (code TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE, created_at INTEGER NOT NULL);
      -- One row per member who joined through someone's invite link. It doubles as the
      -- credit ledger: earned when their first listing goes live, redeemed for a Featured week.
      CREATE TABLE IF NOT EXISTS invites (
        invitee_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        product_id TEXT,
        earned_at INTEGER,
        redeemed_product TEXT,
        redeemed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS invites_inviter ON invites(inviter_id, earned_at);
      -- Karma: an append-only ledger. dedupe makes a retry or a double click pay once.
      CREATE TABLE IF NOT EXISTS karma_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        ref TEXT NOT NULL DEFAULT '',
        points INTEGER NOT NULL,
        day TEXT NOT NULL DEFAULT '',
        dedupe TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS karma_user ON karma_events(user_id, created_at);
      CREATE INDEX IF NOT EXISTS karma_time ON karma_events(created_at);
      CREATE INDEX IF NOT EXISTS karma_daily ON karma_events(user_id, action, day);
      CREATE INDEX IF NOT EXISTS karma_ref ON karma_events(ref);
      -- A free Featured week for every KARMA_PER_CREDIT karma: one row per milestone crossed, never granted twice.
      CREATE TABLE IF NOT EXISTS karma_credits (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        milestone INTEGER NOT NULL,
        granted_at INTEGER NOT NULL,
        redeemed_product TEXT,
        redeemed_at INTEGER,
        PRIMARY KEY (user_id, milestone)
      );
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        parent_id TEXT,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS comments_product ON comments(product_id, created_at);
      CREATE TABLE IF NOT EXISTS reviews (
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating INTEGER NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (product_id, user_id)
      );
      -- Outside sign-ins (Sign in with CoinPay): linked by the provider's subject, never by email.
      CREATE TABLE IF NOT EXISTS user_identities (
        provider TEXT NOT NULL,
        subject TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        email TEXT,
        name TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (provider, subject)
      );
      CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities(user_id);
      CREATE TABLE IF NOT EXISTS payments (
        ref TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        amount_usd REAL NOT NULL,
        chain TEXT NOT NULL,
        days INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `)
    // Columns added after launch: CREATE TABLE IF NOT EXISTS leaves an existing table as it was.
    const has = (table: string, col: string) => (this.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === col)
    if (!has('users', 'display_name')) this.db.exec('ALTER TABLE users ADD COLUMN display_name TEXT')
    if (!has('magic_links', 'ref')) this.db.exec('ALTER TABLE magic_links ADD COLUMN ref TEXT')
    // The signup form's profile fields ride on the link until it is spent (profile.ts saves them).
    if (!has('magic_links', 'profile')) this.db.exec('ALTER TABLE magic_links ADD COLUMN profile TEXT')
    // Hosted checkout sessions (0.5.0): the session is how CoinPay's webhook finds the row.
    for (const col of ['checkout_session_id', 'customer_email', 'account_id', 'payment_id']) if (!has('payments', col)) this.db.exec(`ALTER TABLE payments ADD COLUMN ${col} TEXT`)
    // Karma (0.6.0): who cast a vote, when they were signed in; review totals beside the vote count.
    if (!has('votes', 'user_id')) this.db.exec('ALTER TABLE votes ADD COLUMN user_id TEXT')
    for (const col of ['review_count', 'review_sum']) if (!has('products', col)) this.db.exec(`ALTER TABLE products ADD COLUMN ${col} INTEGER NOT NULL DEFAULT 0`)
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS payments_session ON payments(checkout_session_id) WHERE checkout_session_id IS NOT NULL')
    this.backfillTags()
  }

  /** Listings launched before tags were inferred get topics from their own words; tagged ones are left alone. */
  backfillTags(): number {
    const rows = this.db.query("SELECT id, name, tagline, description FROM products WHERE tags = '[]'").all() as { id: string; name: string; tagline: string; description: string }[]
    const set = this.db.query('UPDATE products SET tags = ? WHERE id = ?')
    let n = 0
    for (const r of rows) {
      const tags = inferTags([r.name, r.tagline, r.description].filter(Boolean).join('. '))
      if (tags.length) set.run(JSON.stringify(tags), r.id), n++
    }
    return n
  }

  /** One visitor, per product, without keeping their address. */
  voterFor(ip: string): string {
    return createHmac('sha256', this.secret).update(`voter:${ip}`).digest('base64url').slice(0, 22)
  }

  private toProduct(row: any): Product | null {
    if (!row) return null
    const j = (v: string | null, d: unknown) => (v ? JSON.parse(v) : d)
    return {
      id: row.id,
      slug: row.slug,
      url: row.url,
      domain: row.domain,
      name: row.name,
      tagline: row.tagline,
      description: row.description,
      logo: row.logo,
      ogImage: row.og_image,
      screenshot: row.screenshot,
      images: j(row.images, []),
      videos: j(row.videos, []),
      socials: j(row.socials, {}),
      tags: j(row.tags, []),
      themeColor: row.theme_color,
      llms: j(row.llms, null),
      profile: j(row.profile, null),
      record: j(row.record, null),
      extras: j(row.extras, { stack: null, pricing: null, openicon: null }),
      makerName: row.maker_name,
      makerProfile: row.maker_profile,
      makerId: row.maker_id,
      makerVerified: Boolean(row.maker_verified),
      ownerId: row.owner_id,
      claimedAt: row.claimed_at,
      submitterUser: row.submitter_user,
      status: row.status,
      votes: row.votes,
      reviews: row.review_count ?? 0,
      rating: row.review_count ? Math.round((row.review_sum / row.review_count) * 10) / 10 : null,
      verifiedAt: row.verified_at,
      featuredUntil: row.featured_until,
      launchedAt: row.launched_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /** The same product typed two ways: no scheme, no www, no trailing slash, no query. */
  static urlKey(url: string): string {
    const u = new URL(url)
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase()
  }

  byUrl(url: string): Product | null {
    return this.toProduct(this.db.query("SELECT * FROM products WHERE url_key = ? AND status != 'hidden' ORDER BY created_at LIMIT 1").get(Store.urlKey(url)))
  }

  /** The live listing for a site's homepage (any page of it), for badges that only know the site: its homepage listing first, else any listing on that host. */
  bySite(site: string): Product | null {
    let host: string
    try {
      host = new URL(/^https?:\/\//i.test(site) ? site : `https://${site}`).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      return null
    }
    return this.toProduct(
      this.db.query("SELECT * FROM products WHERE status = 'live' AND (url_key = ? OR domain = ? OR domain = ?) ORDER BY url_key = ? DESC, created_at LIMIT 1").get(host, host, `www.${host}`, host),
    )
  }

  /** Live listings with no badge found yet: the re-verify sweep's work list. */
  unverified(limit = 200): Product[] {
    return (this.db.query("SELECT * FROM products WHERE status = 'live' AND verified_at IS NULL ORDER BY launched_at LIMIT ?").all(limit) as any[]).map((r) => this.toProduct(r)!)
  }

  freeSlug(name: string): string {
    const base = slugify(name)
    let slug = base
    for (let n = 2; this.db.query('SELECT 1 FROM products WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`
    return slug
  }

  create(p: Omit<Product, 'votes' | 'reviews' | 'rating' | 'verifiedAt' | 'featuredUntil' | 'launchedAt' | 'createdAt' | 'updatedAt' | 'makerId' | 'makerVerified' | 'ownerId' | 'claimedAt'>, submitter: string, now = Date.now()): Product {
    this.db
      .query(
        `INSERT INTO products (id, slug, url, url_key, domain, name, tagline, description, logo, og_image, screenshot, images, videos, socials, tags, theme_color, llms, profile, record, extras, maker_name, maker_profile, status, submitter_user, submitter, launched_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(p.id, p.slug, p.url, Store.urlKey(p.url), p.domain, p.name, p.tagline, p.description, p.logo, p.ogImage, p.screenshot, JSON.stringify(p.images), JSON.stringify(p.videos), JSON.stringify(p.socials), JSON.stringify(p.tags), p.themeColor, p.llms ? JSON.stringify(p.llms) : null, p.profile ? JSON.stringify(p.profile) : null, p.record ? JSON.stringify(p.record) : null, JSON.stringify(p.extras), p.makerName, p.makerProfile, p.status, p.submitterUser, submitter, p.status === 'live' ? now : null, now, now)
    return this.product(p.id)!
  }

  /** The owner, or (until someone claims it) the signed-in person who submitted it. */
  canEdit(p: Product, user: User | null): boolean {
    if (!user || p.status === 'hidden') return false
    return p.ownerId ? p.ownerId === user.id : p.submitterUser === user.id
  }

  claim(id: string, userId: string, now = Date.now()): void {
    this.db.query('UPDATE products SET owner_id = ?, claimed_at = ?, updated_at = ? WHERE id = ?').run(userId, now, now, id)
  }

  /**
   * The badge id for this account on this listing: opaque, URL-safe, 16 chars, made
   * once and handed back every time after, so a badge placed yesterday still counts.
   */
  badgeId(productId: string, userId: string, now = Date.now()): string {
    this.db.query('INSERT OR IGNORE INTO badge_ids (id, product_id, user_id, created_at) VALUES (?, ?, ?, ?)').run(newId(12), productId, userId, now)
    return (this.db.query('SELECT id FROM badge_ids WHERE product_id = ? AND user_id = ?').get(productId, userId) as { id: string }).id
  }

  /** Whose badge id this is: the listing and the account it was made for. */
  badge(id: string): { productId: string; userId: string } | null {
    const row = this.db.query('SELECT product_id, user_id FROM badge_ids WHERE id = ?').get(id) as { product_id: string; user_id: string } | null
    return row ? { productId: row.product_id, userId: row.user_id } : null
  }

  /** Everything a person owns or submitted, newest first. */
  mine(userId: string): Product[] {
    return (this.db.query("SELECT * FROM products WHERE (owner_id = ? OR (owner_id IS NULL AND submitter_user = ?)) AND status != 'hidden' ORDER BY created_at DESC").all(userId, userId) as any[]).map((r) => this.toProduct(r)!)
  }

  // Accounts: an email address, sessions, magic links, API keys. Secrets are kept as SHA-256 only.

  findOrCreateUser(email: string, now = Date.now()): User {
    this.db.query('INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)').run(newId(), email.toLowerCase(), now)
    return this.toUser(this.db.query('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()))!
  }

  user(id: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE id = ?').get(id))
  }

  private toUser(r: any): User | null {
    return r ? { id: r.id, email: r.email, createdAt: r.created_at, displayName: r.display_name ?? null } : null
  }

  userByEmail(email: string): User | null {
    return this.toUser(this.db.query('SELECT * FROM users WHERE email = ?').get(email.toLowerCase()))
  }

  setDisplayName(userId: string, name: string | null): void {
    this.db.query('UPDATE users SET display_name = ? WHERE id = ?').run(name, userId)
  }

  /** What the public sees for a member: the name they chose, else their best listing, never the email. */
  publicName(userId: string): string {
    const u = this.user(userId)
    if (u?.displayName) return u.displayName
    const p = this.db.query("SELECT name FROM products WHERE (owner_id = ? OR (owner_id IS NULL AND submitter_user = ?)) AND status = 'live' ORDER BY votes DESC LIMIT 1").get(userId, userId) as { name: string } | null
    return p ? `Maker of ${p.name}` : `Member ${userId.slice(0, 4)}`
  }

  // The invite program: a link per member; each new member it brings in who launches earns the inviter a free Featured week.

  /** This member's invite code, made once. */
  inviteCode(userId: string, now = Date.now()): string {
    this.db.query('INSERT OR IGNORE INTO invite_codes (code, user_id, created_at) VALUES (?, ?, ?)').run(newId(6), userId, now)
    return (this.db.query('SELECT code FROM invite_codes WHERE user_id = ?').get(userId) as { code: string }).code
  }

  inviterOf(code: string): string | null {
    const r = this.db.query('SELECT user_id FROM invite_codes WHERE code = ?').get(String(code)) as { user_id: string } | null
    return r?.user_id ?? null
  }

  /** A new member joined through `code`. Once per member, never yourself. True when it counted. */
  recordInvite(inviteeId: string, code: string, now = Date.now()): boolean {
    const inviter = this.inviterOf(code)
    if (!inviter || inviter === inviteeId) return false
    return this.db.query('INSERT OR IGNORE INTO invites (invitee_id, inviter_id, created_at) VALUES (?, ?, ?)').run(inviteeId, inviter, now).changes > 0
  }

  /** The invited member's listing went live: their inviter earns a credit, the first time only. Returns the inviter. */
  earnInvite(inviteeId: string, productId: string, now = Date.now()): string | null {
    const r = this.db.query('UPDATE invites SET product_id = ?, earned_at = ? WHERE invitee_id = ? AND earned_at IS NULL RETURNING inviter_id').get(productId, now, inviteeId) as { inviter_id: string } | null
    return r?.inviter_id ?? null
  }

  /** A listing taken down for spam takes back the credit it earned, unless it was already spent. */
  revokeInvite(productId: string): void {
    this.db.query('UPDATE invites SET product_id = NULL, earned_at = NULL WHERE product_id = ? AND redeemed_at IS NULL').run(productId)
  }

  inviteStats(userId: string): InviteStats {
    const r = this.db
      .query('SELECT COUNT(*) AS invited, COUNT(earned_at) AS launched, COUNT(redeemed_at) AS used FROM invites WHERE inviter_id = ?')
      .get(userId) as { invited: number; launched: number; used: number }
    const k = this.db.query('SELECT COUNT(*) AS granted, COUNT(redeemed_at) AS used FROM karma_credits WHERE user_id = ?').get(userId) as { granted: number; used: number }
    const karmaCredits = k.granted - k.used
    return { code: this.inviteCode(userId), invited: r.invited, launched: r.launched, used: r.used + k.used, credits: r.launched - r.used + karmaCredits, karmaCredits }
  }

  /** Spend one earned credit: the product is featured for `days` more. False when there is no credit left. */
  redeemCredit(userId: string, productId: string, days: number, now = Date.now()): boolean {
    return this.db.transaction(() => {
      const r = this.db
        .query('UPDATE invites SET redeemed_product = ?, redeemed_at = ? WHERE invitee_id = (SELECT invitee_id FROM invites WHERE inviter_id = ? AND earned_at IS NOT NULL AND redeemed_at IS NULL ORDER BY earned_at LIMIT 1)')
        .run(productId, now, userId)
      // No invite credit left: a karma credit is the same free week.
      if (!r.changes && !this.db.query('UPDATE karma_credits SET redeemed_product = ?, redeemed_at = ? WHERE rowid = (SELECT rowid FROM karma_credits WHERE user_id = ? AND redeemed_at IS NULL ORDER BY milestone LIMIT 1)').run(productId, now, userId).changes) return false
      this.extendFeatured(productId, days, now)
      return true
    })()
  }

  /** Every credit earned since `since`, for the inviters' leaderboard. */
  earnedInvites(since = 0): { inviter: string; at: number }[] {
    return (this.db.query('SELECT inviter_id, earned_at FROM invites WHERE earned_at IS NOT NULL AND earned_at >= ?').all(since) as { inviter_id: string; earned_at: number }[]).map((r) => ({ inviter: r.inviter_id, at: r.earned_at }))
  }

  // Outside identities (Sign in with CoinPay).

  /** The member an outside account is linked to. */
  identityUser(provider: string, subject: string): User | null {
    const r = this.db.query('SELECT user_id FROM user_identities WHERE provider = ? AND subject = ?').get(provider, subject) as { user_id: string } | null
    return r ? this.user(r.user_id) : null
  }

  /** Link an outside account to a member. False when it already belongs to someone else. */
  linkIdentity(i: { provider: string; subject: string; userId: string; email?: string | null; name?: string | null }, now = Date.now()): boolean {
    const owner = this.identityUser(i.provider, i.subject)
    if (owner && owner.id !== i.userId) return false
    this.db.query('INSERT INTO user_identities (provider, subject, user_id, email, name, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(provider, subject) DO UPDATE SET email = excluded.email, name = excluded.name').run(i.provider, i.subject, i.userId, i.email ?? null, i.name ?? null, now)
    return true
  }

  identities(userId: string): { provider: string; subject: string; email: string | null; name: string | null }[] {
    return this.db.query('SELECT provider, subject, email, name FROM user_identities WHERE user_id = ? ORDER BY created_at').all(userId) as { provider: string; subject: string; email: string | null; name: string | null }[]
  }

  // Karma: the ledger. Rules (what pays, caps, self-dealing) live in karma.ts; this is storage.

  /**
   * Write one ledger row unless its dedupe key is taken, or a daily cap for the action
   * is full. True when it was written. One transaction, so two clicks cannot both pass the cap.
   */
  addKarma(e: { userId: string; action: string; ref: string; points: number; dedupe: string; daily?: boolean; cap?: number }, now = Date.now()): boolean {
    const day = e.daily || e.cap ? dayOf(now) : ''
    return this.db.transaction(() => {
      if (e.cap && (this.db.query('SELECT COUNT(*) AS n FROM karma_events WHERE user_id = ? AND action = ? AND day = ? AND points > 0').get(e.userId, e.action, day) as { n: number }).n >= e.cap) return false
      return this.db.query('INSERT OR IGNORE INTO karma_events (id, user_id, action, ref, points, day, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), e.userId, e.action, e.ref, e.points, day, e.dedupe, now).changes > 0
    })()
  }

  /** Take back what one ledger row paid: a new negative row, once. The user it paid, or null when there was nothing to reverse. */
  reverseKarma(dedupe: string, action: string, now = Date.now()): string | null {
    const row = this.db.query('SELECT id, user_id, ref, points FROM karma_events WHERE dedupe = ? AND points > 0').get(dedupe) as { id: string; user_id: string; ref: string; points: number } | null
    if (!row) return null
    const r = this.db.query('INSERT OR IGNORE INTO karma_events (id, user_id, action, ref, points, day, dedupe, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(newId(), row.user_id, action, row.ref, -row.points, '', `reverse:${row.id}`, now)
    return r.changes ? row.user_id : null
  }

  /** Every unreversed positive row about a listing (its id, or `<id>:…`): what a takedown takes back. */
  karmaAbout(productId: string): string[] {
    return (this.db.query("SELECT e.dedupe FROM karma_events e WHERE (e.ref = ? OR e.ref LIKE ? ESCAPE '\\') AND e.points > 0 AND NOT EXISTS (SELECT 1 FROM karma_events r WHERE r.dedupe = 'reverse:' || e.id)").all(productId, `${productId.replace(/[\\%_]/g, (c) => `\\${c}`)}:%`) as { dedupe: string }[]).map((r) => r.dedupe)
  }

  karmaTotal(userId: string, since = 0): number {
    return (this.db.query('SELECT COALESCE(SUM(points), 0) AS n FROM karma_events WHERE user_id = ? AND created_at >= ?').get(userId, since) as { n: number }).n
  }

  /** Several members' all-time karma at once, for the names next to comments and reviews. */
  karmaOf(userIds: string[]): Map<string, number> {
    const ids = [...new Set(userIds)]
    if (!ids.length) return new Map()
    const rows = this.db.query(`SELECT user_id, COALESCE(SUM(points), 0) AS n FROM karma_events WHERE user_id IN (${ids.map(() => '?').join(',')}) GROUP BY user_id`).all(...ids) as { user_id: string; n: number }[]
    return new Map(ids.map((id) => [id, rows.find((r) => r.user_id === id)?.n ?? 0]))
  }

  karmaEvents(userId: string, limit = 30): KarmaEvent[] {
    return (this.db.query('SELECT * FROM karma_events WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(userId, limit) as any[]).map((r) => ({ id: r.id, userId: r.user_id, action: r.action, ref: r.ref, points: r.points, createdAt: r.created_at }))
  }

  /** Every ledger row since `since`, for the karma leaderboard. */
  karmaSince(since = 0): { userId: string; points: number; at: number }[] {
    return (this.db.query('SELECT user_id, points, created_at FROM karma_events WHERE created_at >= ?').all(since) as { user_id: string; points: number; created_at: number }[]).map((r) => ({ userId: r.user_id, points: r.points, at: r.created_at }))
  }

  /** Grant a credit for every `per` karma milestone reached and not granted before. Returns how many were new. */
  grantKarmaCredits(userId: string, per: number, now = Date.now()): number {
    if (!(per > 0)) return 0
    const reached = Math.floor(this.karmaTotal(userId) / per)
    let n = 0
    for (let m = 1; m <= reached; m++) n += this.db.query('INSERT OR IGNORE INTO karma_credits (user_id, milestone, granted_at) VALUES (?, ?, ?)').run(userId, m * per, now).changes
    return n
  }

  karmaCredits(userId: string): { granted: number; used: number; best: number } {
    return this.db.query('SELECT COUNT(*) AS granted, COUNT(redeemed_at) AS used, COALESCE(MAX(milestone), 0) AS best FROM karma_credits WHERE user_id = ?').get(userId) as { granted: number; used: number; best: number }
  }

  // Comments and reviews.

  addComment(c: { productId: string; userId: string; parentId: string | null; body: string }, now = Date.now()): Comment {
    const id = newId()
    this.db.query('INSERT INTO comments (id, product_id, user_id, parent_id, body, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, c.productId, c.userId, c.parentId, c.body, now)
    return this.comment(id)!
  }

  comment(id: string): Comment | null {
    const r: any = this.db.query('SELECT * FROM comments WHERE id = ?').get(id)
    return r ? { id: r.id, productId: r.product_id, userId: r.user_id, parentId: r.parent_id, body: r.body, createdAt: r.created_at, deletedAt: r.deleted_at } : null
  }

  /** A listing's comments, oldest first; deleted ones only while a reply hangs off them. */
  comments(productId: string): Comment[] {
    return (this.db.query('SELECT * FROM comments c WHERE product_id = ? AND (deleted_at IS NULL OR EXISTS (SELECT 1 FROM comments r WHERE r.parent_id = c.id AND r.deleted_at IS NULL)) ORDER BY created_at, rowid').all(productId) as any[]).map((r) => ({ id: r.id, productId: r.product_id, userId: r.user_id, parentId: r.parent_id, body: r.deleted_at ? '' : r.body, createdAt: r.created_at, deletedAt: r.deleted_at }))
  }

  /** Soft delete: replies keep their place; the words go. */
  deleteComment(id: string, now = Date.now()): boolean {
    return this.db.query("UPDATE comments SET deleted_at = ?, body = '' WHERE id = ? AND deleted_at IS NULL").run(now, id).changes > 0
  }

  /** Write or replace a member's review; the listing's totals follow. */
  putReview(r: { productId: string; userId: string; rating: number; body: string }, now = Date.now()): Review {
    this.db.transaction(() => {
      this.db.query('INSERT INTO reviews (product_id, user_id, rating, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(product_id, user_id) DO UPDATE SET rating = excluded.rating, body = excluded.body, updated_at = excluded.updated_at').run(r.productId, r.userId, r.rating, r.body, now, now)
      this.reviewTotals(r.productId)
    })()
    return this.review(r.productId, r.userId)!
  }

  deleteReview(productId: string, userId: string): boolean {
    return this.db.transaction(() => {
      const n = this.db.query('DELETE FROM reviews WHERE product_id = ? AND user_id = ?').run(productId, userId).changes
      this.reviewTotals(productId)
      return n > 0
    })()
  }

  private reviewTotals(productId: string): void {
    this.db.query('UPDATE products SET review_count = (SELECT COUNT(*) FROM reviews WHERE product_id = ?), review_sum = (SELECT COALESCE(SUM(rating), 0) FROM reviews WHERE product_id = ?) WHERE id = ?').run(productId, productId, productId)
  }

  review(productId: string, userId: string): Review | null {
    const r: any = this.db.query('SELECT * FROM reviews WHERE product_id = ? AND user_id = ?').get(productId, userId)
    return r ? { productId: r.product_id, userId: r.user_id, rating: r.rating, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at } : null
  }

  reviews(productId: string): Review[] {
    return (this.db.query('SELECT * FROM reviews WHERE product_id = ? ORDER BY updated_at DESC').all(productId) as any[]).map((r) => ({ productId: r.product_id, userId: r.user_id, rating: r.rating, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at }))
  }

  newApiKey(userId: string, now = Date.now()): string {
    const key = `bi_${randomBytes(24).toString('base64url')}`
    this.db.query('DELETE FROM api_keys WHERE user_id = ?').run(userId)
    this.db.query('INSERT INTO api_keys (key_hash, user_id, created_at) VALUES (?, ?, ?)').run(hashKey(key), userId, now)
    return key
  }

  byApiKey(key: string): User | null {
    if (!key.startsWith('bi_')) return null
    const r: any = this.db.query('SELECT user_id FROM api_keys WHERE key_hash = ?').get(hashKey(key))
    return r ? this.user(r.user_id) : null
  }

  /** Change what the maker may change. Only known columns; JSON for the lists. */
  update(id: string, patch: Partial<Pick<Product, 'name' | 'tagline' | 'description' | 'logo' | 'ogImage' | 'screenshot' | 'images' | 'videos' | 'socials' | 'tags' | 'themeColor' | 'llms' | 'profile' | 'record' | 'extras' | 'makerName' | 'makerProfile' | 'makerId' | 'makerVerified' | 'status' | 'url' | 'domain'>>, now = Date.now()): Product | null {
    const cols: Record<string, string> = { name: 'name', tagline: 'tagline', description: 'description', logo: 'logo', ogImage: 'og_image', screenshot: 'screenshot', images: 'images', videos: 'videos', socials: 'socials', tags: 'tags', themeColor: 'theme_color', llms: 'llms', profile: 'profile', record: 'record', extras: 'extras', makerName: 'maker_name', makerProfile: 'maker_profile', makerId: 'maker_id', makerVerified: 'maker_verified', status: 'status', url: 'url', domain: 'domain' }
    const sets: string[] = []
    const values: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k]
      if (!col || v === undefined) continue
      sets.push(`${col} = ?`)
      values.push(v === null ? null : typeof v === 'object' ? JSON.stringify(v) : typeof v === 'boolean' ? Number(v) : v)
      if (k === 'url') sets.push('url_key = ?'), values.push(Store.urlKey(String(v)))
    }
    if (patch.status === 'live') sets.push('launched_at = COALESCE(launched_at, ?)'), values.push(now)
    if (!sets.length) return this.product(id)
    sets.push('updated_at = ?')
    values.push(now, id)
    this.db.query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`).run(...values)
    return this.product(id)
  }

  product(id: string): Product | null {
    return this.toProduct(this.db.query('SELECT * FROM products WHERE id = ?').get(id))
  }

  bySlug(slug: string): Product | null {
    return this.toProduct(this.db.query('SELECT * FROM products WHERE slug = ?').get(slug.toLowerCase()))
  }

  delete(id: string): void {
    this.db.query('DELETE FROM products WHERE id = ?').run(id)
  }

  /** Drafts nobody published within a day; returns their ids so the pictures go too. */
  sweepDrafts(now = Date.now()): string[] {
    return (this.db.query("DELETE FROM products WHERE status = 'draft' AND created_at < ? RETURNING id").all(now - 86400_000) as { id: string }[]).map((r) => r.id)
  }

  submissionsFrom(submitter: string, sinceMs: number): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM products WHERE submitter = ? AND created_at > ?').get(submitter, sinceMs) as { n: number }).n
  }

  /** Live products for a window, best first. `today` etc. are UTC launch days; `new` is newest first. */
  list(window: Window = 'today', limit = 30, offset = 0, now = Date.now()): Product[] {
    const day = 86400_000
    const since = { today: startOfDay(now), week: now - 7 * day, month: now - 30 * day, all: 0, new: 0, featured: 0 }[window]
    const where = window === 'featured' ? "status = 'live' AND featured_until > ?" : "status = 'live' AND launched_at >= ?"
    const order = window === 'new' ? 'launched_at DESC' : 'votes DESC, launched_at ASC'
    return (this.db.query(`SELECT * FROM products WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(window === 'featured' ? now : since, limit, offset) as any[]).map((r) => this.toProduct(r)!)
  }

  onDay(day: string, limit = 50): Product[] {
    const from = Date.parse(`${day}T00:00:00Z`)
    return (this.db.query("SELECT * FROM products WHERE status = 'live' AND launched_at >= ? AND launched_at < ? ORDER BY votes DESC, launched_at ASC LIMIT ?").all(from, from + 86400_000, limit) as any[]).map((r) => this.toProduct(r)!)
  }

  byMaker(makerId: string): Product[] {
    return (this.db.query("SELECT * FROM products WHERE maker_id = ? AND status = 'live' ORDER BY launched_at DESC").all(makerId) as any[]).map((r) => this.toProduct(r)!)
  }

  search(q: string, limit = 30): Product[] {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
    return (this.db.query("SELECT * FROM products WHERE status = 'live' AND (name LIKE ? ESCAPE '\\' OR tagline LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\') ORDER BY votes DESC LIMIT ?").all(like, like, like, like, limit) as any[]).map((r) => this.toProduct(r)!)
  }

  /** Live products with this exact tag, best first. */
  byTag(tag: string, limit = 50): Product[] {
    return (this.db.query("SELECT p.* FROM products p WHERE p.status = 'live' AND EXISTS (SELECT 1 FROM json_each(p.tags) WHERE value = ?) ORDER BY p.votes DESC, p.launched_at DESC LIMIT ?").all(tag, limit) as any[]).map((r) => this.toProduct(r)!)
  }

  /** Every tag on a live product, with how many carry it; most used first. */
  tagCounts(limit = 200): { tag: string; count: number }[] {
    return this.db.query("SELECT t.value AS tag, COUNT(*) AS count FROM products p, json_each(p.tags) t WHERE p.status = 'live' GROUP BY t.value ORDER BY count DESC, tag LIMIT ?").all(limit) as { tag: string; count: number }[]
  }
  /** Every live launch, for browse.ts to filter and count. Cached until something changes. */
  allLive(): Product[] {
    const stamp = this.db.query("SELECT COUNT(*) AS n, MAX(updated_at) AS u, SUM(votes) AS v, SUM(COALESCE(featured_until, 0)) AS f, COUNT(verified_at) AS c, SUM(review_count) AS rc, SUM(review_sum) AS rs FROM products WHERE status = 'live'").get() as Record<string, number | null>
    const key = `${stamp.n}:${stamp.u}:${stamp.v}:${stamp.f}:${stamp.c}:${stamp.rc}:${stamp.rs}`
    if (this.liveCache?.key !== key) this.liveCache = { key, products: (this.db.query("SELECT * FROM products WHERE status = 'live'").all() as any[]).map((r) => this.toProduct(r)!) }
    return this.liveCache.products
  }
  private liveCache: { key: string; products: Product[] } | null = null

  count(): { products: number; votes: number } {
    return this.db.query("SELECT (SELECT COUNT(*) FROM products WHERE status = 'live') AS products, (SELECT COUNT(*) FROM votes) AS votes").get() as { products: number; votes: number }
  }

  /** #1 of its launch day, once that day is over. */
  awards(productId: string, now = Date.now()): { day: string; rank: number } | null {
    const p = this.product(productId)
    if (!p?.launchedAt || startOfDay(p.launchedAt) >= startOfDay(now)) return null
    const day = dayOf(p.launchedAt)
    const rank = this.onDay(day, 3).findIndex((x) => x.id === productId)
    return rank >= 0 ? { day, rank: rank + 1 } : null
  }

  /** One vote per visitor per product. True when it counted. */
  vote(productId: string, voter: string, now = Date.now(), userId: string | null = null): boolean {
    const r = this.db.query('INSERT OR IGNORE INTO votes (product_id, voter, created_at, user_id) VALUES (?, ?, ?, ?)').run(productId, voter, now, userId)
    if (!r.changes) return false
    this.db.query('UPDATE products SET votes = votes + 1 WHERE id = ?').run(productId)
    return true
  }

  voted(productId: string, voter: string): boolean {
    return Boolean(this.db.query('SELECT 1 FROM votes WHERE product_id = ? AND voter = ?').get(productId, voter))
  }

  setVerified(id: string, at: number | null): void {
    this.db.query('UPDATE products SET verified_at = ? WHERE id = ?').run(at, id)
  }

  upsertMaker(m: Omit<Maker, 'id' | 'createdAt'>, now = Date.now()): Maker {
    const id = makerIdFor(m.profileUrl)
    this.db
      .query(
        `INSERT INTO makers (id, name, profile_url, headline, avatar, web, accounts, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, headline = excluded.headline, avatar = excluded.avatar, web = excluded.web, accounts = excluded.accounts`,
      )
      .run(id, m.name, m.profileUrl, m.headline, m.avatar, m.web, JSON.stringify(m.accounts), now)
    return this.maker(id)!
  }

  maker(id: string): Maker | null {
    const r: any = this.db.query('SELECT * FROM makers WHERE id = ?').get(id)
    return r ? { id: r.id, name: r.name, profileUrl: r.profile_url, headline: r.headline, avatar: r.avatar, web: r.web, accounts: JSON.parse(r.accounts), createdAt: r.created_at } : null
  }

  addPayment(p: { ref: string; productId: string; amountUsd: number; chain: string; days: number; checkoutSessionId?: string | null; email?: string | null; accountId?: string | null }, now = Date.now()): void {
    this.db
      .query('INSERT OR IGNORE INTO payments (ref, product_id, amount_usd, chain, days, checkout_session_id, customer_email, account_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(p.ref, p.productId, p.amountUsd, p.chain, p.days, p.checkoutSessionId ?? null, p.email ?? null, p.accountId ?? null, now, now)
  }

  paymentBySession(sessionId: string): { ref: string; productId: string; days: number; status: string } | null {
    const r: any = this.db.query('SELECT ref, product_id, days, status FROM payments WHERE checkout_session_id = ?').get(sessionId)
    return r ? { ref: r.ref, productId: r.product_id, days: r.days, status: r.status } : null
  }

  /** CoinPay's payment id and how it was paid (a coin, or paypal), once a webhook names them. */
  notePaymentId(ref: string, paymentId: string, method: string | null, now = Date.now()): void {
    this.db.query("UPDATE payments SET payment_id = ?, chain = CASE WHEN ? IS NOT NULL AND ? != '' THEN ? ELSE chain END, updated_at = ? WHERE ref = ?").run(paymentId, method, method, method, now, ref)
  }

  deletePayment(ref: string): void {
    this.db.query('DELETE FROM payments WHERE ref = ?').run(ref)
  }

  payment(ref: string): { ref: string; productId: string; days: number; status: string } | null {
    const r: any = this.db.query('SELECT ref, product_id, days, status FROM payments WHERE ref = ?').get(ref)
    return r ? { ref: r.ref, productId: r.product_id, days: r.days, status: r.status } : null
  }

  /** The one way a listing gets Featured time: paid weeks, invite and karma credits, and redeemed Featured days. */
  extendFeatured(productId: string, days: number, now = Date.now()): void {
    this.db.query('UPDATE products SET featured_until = MAX(COALESCE(featured_until, 0), ?) + ? WHERE id = ?').run(now, days * 86400_000, productId)
  }

  /** Mark a payment settled and extend the product's featured time, exactly once per payment. */
  settle(ref: string, now = Date.now()): boolean {
    const r: any = this.db.query("UPDATE payments SET status = 'paid', updated_at = ? WHERE ref = ? AND status != 'paid' RETURNING product_id, days").get(now, ref)
    if (!r) return false
    this.extendFeatured(r.product_id, r.days, now)
    return true
  }

  setPaymentStatus(ref: string, status: string, now = Date.now()): void {
    this.db.query("UPDATE payments SET status = ?, updated_at = ? WHERE ref = ? AND status != 'paid'").run(status, now, ref)
  }
}
