/**
 * Karma: points for helping the board, one network-wide rule set (built.indie and
 * pwamart.com pay the same actions the same points).
 *
 * Every write goes through here and lands in one append-only ledger
 * (karma_events, db.ts). A dedupe key per fact means a retry or a double click
 * never pays twice; a reversal (a comment deleted, a listing taken down) is a
 * new negative row. Signed-in members earn; anonymous actions still work and
 * earn nothing. Acting on your own listing earns nothing. Every
 * KARMA_PER_CREDIT karma grants a free Featured week, once per milestone.
 */
import { dayOf, type Product, type Store } from './db.js'

export const POINTS = {
  launch: 10,
  vote: 1,
  review: 5,
  comment: 2,
  share: 1,
  upvoted: 1,
  reviewed: 2,
  claim: 5,
  invite: 25,
  badge: 5,
} as const
export type KarmaAction = keyof typeof POINTS

/** Paid actions per member per UTC day; past it the action still works, it just pays nothing. */
export const DAILY_CAPS: Partial<Record<KarmaAction, number>> = { vote: 20, comment: 10, share: 5 }

/** The share intents we track: one paid click per listing per network per day. */
export const SHARE_NETWORKS = ['x', 'bluesky', 'linkedin', 'reddit', 'hn', 'mastodon', 'copy'] as const
export type ShareNetwork = (typeof SHARE_NETWORKS)[number]

export const MIN_REVIEW_CHARS = 30
export const MIN_COMMENT_CHARS = 10

/** What each ledger action reads as, in history lists. */
export const ACTION_LABELS: Record<string, string> = {
  launch: 'Launched a listing',
  vote: 'Upvoted a launch',
  review: 'Reviewed a launch',
  comment: 'Commented',
  share: 'Shared a launch',
  upvoted: 'Your launch got an upvote',
  reviewed: 'Your launch got a review',
  claim: 'Claimed a listing',
  invite: 'An invited maker launched',
  badge: 'Badge verified on your site',
  comment_deleted: 'Comment deleted',
  review_deleted: 'Review deleted',
  reviewed_deleted: 'A review of your launch was deleted',
  taken_down: 'Listing taken down',
}

/** The "how to earn" table, for the member page, the leaderboard and the docs. */
export const HOW_TO_EARN: { action: string; points: number; rule: string }[] = [
  { action: 'Launch a listing', points: POINTS.launch, rule: 'the first time each listing goes live' },
  { action: 'Upvote', points: POINTS.vote, rule: `not your own listing; up to ${DAILY_CAPS.vote} paid a day` },
  { action: 'Review', points: POINTS.review, rule: `stars and at least ${MIN_REVIEW_CHARS} characters; once per listing; not your own` },
  { action: 'Comment', points: POINTS.comment, rule: `at least ${MIN_COMMENT_CHARS} characters; up to ${DAILY_CAPS.comment} paid a day; deleting it takes the points back` },
  { action: 'Share', points: POINTS.share, rule: `a share button (X, Bluesky, LinkedIn, Reddit, HN, Mastodon, copy link); once per listing per network per day; up to ${DAILY_CAPS.share} a day` },
  { action: 'Your launch gets an upvote', points: POINTS.upvoted, rule: 'from a signed-in member who is not you' },
  { action: 'Your launch gets a review', points: POINTS.reviewed, rule: 'from someone else' },
  { action: 'Claim your listing', points: POINTS.claim, rule: 'prove you own the domain (badge or DNS), once per listing' },
  { action: 'Invite a maker who launches', points: POINTS.invite, rule: 'a new member from your invite link launches their first listing' },
  { action: 'Badge verified', points: POINTS.badge, rule: 'our badge is on your homepage and we found it, once per listing' },
]

/** Who a listing's karma goes to: the owner who claimed it, else the member who launched it. */
export const ownerOf = (p: Pick<Product, 'ownerId' | 'submitterUser'>) => p.ownerId ?? p.submitterUser ?? null
const isSelf = (p: Pick<Product, 'ownerId' | 'submitterUser'>, userId: string) => p.ownerId === userId || p.submitterUser === userId

export type KarmaSummary = { total: number; week: number; perCredit: number; nextCreditIn: number; progress: number; credits: { granted: number; used: number }; events: { action: string; label: string; ref: string; points: number; at: number }[] }

export class Karma {
  /** Called after every write that changed someone's karma: the server refreshes the board and awards badges. */
  onChange?: (userId: string) => void
  /** Called when a milestone grants a free Featured week. */
  onCredit?: (userId: string, granted: number) => void

  constructor(readonly store: Store, readonly perCredit = 500) {}

  private pay(userId: string | null, action: KarmaAction, ref: string, dedupe: string, opts: { daily?: boolean; capped?: boolean } = {}, now = Date.now()): boolean {
    if (!userId) return false
    const ok = this.store.addKarma({ userId, action, ref, points: POINTS[action], dedupe, daily: opts.daily, cap: opts.capped ? DAILY_CAPS[action] : undefined }, now)
    if (ok) this.changed(userId, now)
    return ok
  }

  private changed(userId: string, now = Date.now()): void {
    const granted = this.store.grantKarmaCredits(userId, this.perCredit, now)
    if (granted) this.onCredit?.(userId, granted)
    this.onChange?.(userId)
  }

  private reverse(dedupe: string, action: string): boolean {
    const userId = this.store.reverseKarma(dedupe, action)
    if (userId) this.onChange?.(userId)
    return Boolean(userId)
  }

  /** A listing went live for the first time. Not for anonymous or admin-bearer imports (no member). */
  launched(p: Product, userId: string | null = p.submitterUser): boolean {
    return this.pay(userId, 'launch', p.id, `launch:${p.id}`)
  }

  /** A counted vote. The voter earns (capped), the owner earns for a vote from someone else; both only when the voter is a member and not the owner. */
  voted(p: Product, voterId: string | null, now = Date.now()): { voter: boolean; owner: boolean } {
    if (!voterId || isSelf(p, voterId)) return { voter: false, owner: false }
    const voter = this.pay(voterId, 'vote', p.id, `vote:${voterId}:${p.id}`, { capped: true }, now)
    const owner = this.pay(ownerOf(p), 'upvoted', `${p.id}:${voterId}`, `upvoted:${p.id}:${voterId}`, {}, now)
    return { voter, owner }
  }

  /** A review saved (new or edited). Pays once per listing, when it has stars and enough words, and never on your own. */
  reviewed(p: Product, userId: string, review: { rating: number; body: string }): { reviewer: boolean; owner: boolean } {
    if (isSelf(p, userId) || !(review.rating >= 1 && review.rating <= 5) || review.body.trim().length < MIN_REVIEW_CHARS) return { reviewer: false, owner: false }
    const reviewer = this.pay(userId, 'review', p.id, `review:${userId}:${p.id}`)
    const owner = this.pay(ownerOf(p), 'reviewed', `${p.id}:${userId}`, `reviewed:${p.id}:${userId}`)
    return { reviewer, owner }
  }

  /** A review deleted: both sides give back what it paid. Writing a new one later pays nothing again. */
  unreviewed(p: Product, userId: string): void {
    this.reverse(`review:${userId}:${p.id}`, 'review_deleted')
    this.reverse(`reviewed:${p.id}:${userId}`, 'reviewed_deleted')
  }

  commented(p: Product, userId: string, comment: { id: string; body: string }, now = Date.now()): boolean {
    if (isSelf(p, userId) || comment.body.trim().length < MIN_COMMENT_CHARS) return false
    return this.pay(userId, 'comment', `${p.id}:${comment.id}`, `comment:${comment.id}`, { capped: true }, now)
  }

  /** A comment deleted (by its author or an admin): the points it earned go back. */
  uncommented(commentId: string): boolean {
    return this.reverse(`comment:${commentId}`, 'comment_deleted')
  }

  shared(p: Product, userId: string | null, network: string, now = Date.now()): boolean {
    if (!userId || isSelf(p, userId) || !(SHARE_NETWORKS as readonly string[]).includes(network)) return false
    return this.pay(userId, 'share', `${p.id}:${network}`, `share:${userId}:${p.id}:${network}:${dayOf(now)}`, { capped: true }, now)
  }

  claimed(p: Product, userId: string): boolean {
    return this.pay(userId, 'claim', p.id, `claim:${p.id}`)
  }

  badgeVerified(p: Product): boolean {
    return this.pay(ownerOf(p), 'badge', p.id, `badge:${p.id}`)
  }

  inviteConverted(inviterId: string, productId: string): boolean {
    return this.pay(inviterId, 'invite', productId, `invite:${productId}`)
  }

  /** A listing taken down for spam: everything it paid anyone goes back. Credits already granted stay granted. */
  takenDown(productId: string): number {
    let n = 0
    for (const key of this.store.karmaAbout(productId)) n += Number(this.reverse(key, 'taken_down'))
    return n
  }

  summary(userId: string, now = Date.now()): KarmaSummary {
    const total = this.store.karmaTotal(userId)
    const credits = this.store.karmaCredits(userId)
    // The next milestone is past both the karma held and the last one granted (a reversal never re-pays a milestone).
    const next = Math.max(Math.floor(Math.max(total, 0) / this.perCredit) + 1, credits.best / this.perCredit + 1) * this.perCredit
    return {
      total,
      week: this.store.karmaTotal(userId, now - 7 * 86400_000),
      perCredit: this.perCredit,
      nextCreditIn: next - total,
      progress: Math.max(0, Math.min(1, 1 - (next - total) / this.perCredit)),
      credits: { granted: credits.granted, used: credits.used },
      events: this.store.karmaEvents(userId).map((e) => ({ action: e.action, label: ACTION_LABELS[e.action] ?? e.action, ref: e.ref, points: e.points, at: e.createdAt })),
    }
  }
}
