/**
 * The inviters' leaderboard, on @profullstack/leaderboard. It projects the
 * invites table (an invite counts once the member it brought in launches), so
 * there is no second copy of the facts to drift; badges, which are awarded
 * rather than derived, live in the same SQLite file (lb_ tables).
 *
 * The package serves /leaderboard.json, /leaderboard/<board>.json|.xml, the
 * share card /leaderboard/u/<id> and the widget /leaderboard/embed.js; the
 * /leaderboard page itself is ours, in the site's layout (server.ts).
 */
import { createLeaderboard, projectionStore, sqlStore, type Period, type Profile } from '@profullstack/leaderboard'
import type { Store } from './db.js'

const count = (p: Profile) => Number(p.totals?.invites ?? 0)
const bestRank = (p: Profile, period: Period) => Math.min(...Object.values(p.ranks ?? {}).map((r) => r?.[period] ?? Infinity))

export function inviteLeaderboard(store: Store, origin: string) {
  const badges = sqlStore({ execute: ({ sql, args }) => ({ rows: store.db.query(sql).all(...((args ?? []) as never[])) as Record<string, unknown>[] }) })
  for (const sql of badges.schema) store.db.exec(sql)
  return createLeaderboard({
    siteName: 'built.indie',
    siteUrl: origin,
    periods: ['week', 'month', 'all'],
    defaultPeriod: 'week',
    sides: { use: 'Inviters' },
    boards: {
      invites: { label: 'Top inviters', metric: 'invites', format: 'integer', unit: 'Makers launched', side: 'use', actor: 'Member', min: 1 },
    },
    badges: [
      { id: 'first-invite', emoji: '🎟️', label: 'First invite', describe: 'Brought in a maker who launched', when: (p) => count(p) >= 1 },
      { id: 'five-invites', emoji: '🚀', label: 'Five makers', describe: 'Five invited makers launched', when: (p) => count(p) >= 5 },
      { id: 'twenty-five-invites', emoji: '🌟', label: 'Twenty-five makers', describe: 'Twenty-five invited makers launched', when: (p) => count(p) >= 25 },
      { id: 'top-ten-week', emoji: '🏅', label: 'Top ten this week', describe: 'In a weekly top ten of inviters', when: (p) => bestRank(p, 'week') <= 10 },
      { id: 'number-one', emoji: '👑', label: 'Number one', describe: 'Top inviter for a week, a month or all time', when: (p) => [bestRank(p, 'week'), bestRank(p, 'month'), bestRank(p, 'all')].includes(1) },
    ],
    store: projectionStore({
      events: async ({ since }: { since: number }) => store.earnedInvites(since).map((e) => ({ player: e.inviter, name: store.publicName(e.inviter), metric: 'invites', delta: 1, at: e.at })),
      badges,
    }),
  })
}

export type InviteBoard = ReturnType<typeof inviteLeaderboard>
