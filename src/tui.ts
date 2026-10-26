/**
 * `builtindie` with no arguments: the board in the terminal.
 *
 * ←/→ switch board (today, week, month, all, new), ↑/↓ pick, Enter shows it,
 * v upvotes, l launches a URL you type, k shows the karma leaderboard, q quits. Glyphs come from the OpenIcon
 * set: Nerd Font, Unicode or ASCII, whichever this terminal can draw.
 */
const UP = glyph('arrow-up') || '^'
const OK = glyph('check') || '+'
import { createApp } from '@profullstack/hqtui'
import { BuiltIndieClient, type ApiProduct, type BoardRows } from './client.js'
import { glyph } from './icons.js'

export const WINDOWS = ['today', 'week', 'month', 'all', 'new'] as const

export type TuiState = {
  window: number
  products: ApiProduct[]
  at: number
  open: ApiProduct | null
  typing: string | null
  busy: string | null
  flash: string | null
  /** The karma leaderboard, while it is open (k). */
  board: BoardRows | null
}

export const initialState = (): TuiState => ({ window: 0, products: [], at: 0, open: null, typing: null, busy: null, flash: null, board: null })

/** Pure key handling, testable without a terminal. */
export function onKey(s: TuiState, key: { name: string; key: string; char?: string }): 'load' | 'vote' | 'launch' | 'karma' | 'quit' | null {
  if (key.key === 'ctrl+c') return 'quit'
  if (s.typing !== null) {
    if (key.name === 'escape') s.typing = null
    else if (key.name === 'enter') return s.typing.trim() ? 'launch' : ((s.typing = null), null)
    else if (key.name === 'backspace') s.typing = s.typing.slice(0, -1)
    else if (key.char && key.char.length === 1 && !key.key.startsWith('ctrl+')) s.typing += key.char
    return null
  }
  if (s.board) {
    if (key.name === 'escape' || key.char === 'k') s.board = null
    else if (key.char === 'q') return 'quit'
    return null
  }
  if (key.name === 'escape') return s.open ? ((s.open = null), null) : 'quit'
  if (key.char === 'q') return 'quit'
  if (key.char === 'k') return 'karma'
  if (key.char === 'l') return (s.typing = ''), null
  if (key.char === 'v') return s.products[s.at] ? 'vote' : null
  if (key.name === 'right' || key.name === 'left') {
    s.window = (s.window + (key.name === 'right' ? 1 : WINDOWS.length - 1)) % WINDOWS.length
    s.at = 0
    s.open = null
    return 'load'
  }
  if (key.name === 'down') s.at = Math.min(s.at + 1, Math.max(0, s.products.length - 1))
  if (key.name === 'up') s.at = Math.max(0, s.at - 1)
  if (key.name === 'enter') s.open = s.products[s.at] ?? null
  return null
}

export async function runTui(client = new BuiltIndieClient()): Promise<void> {
  const s = initialState()
  const app = await createApp({ title: 'built.indie', quitKeys: [] })
  const run = async (label: string, fn: () => Promise<void>) => {
    s.busy = label
    s.flash = null
    app.invalidate()
    try {
      await fn()
    } catch (e) {
      s.flash = e instanceof Error ? e.message : String(e)
    } finally {
      s.busy = null
      app.invalidate()
    }
  }
  const load = () => run('Loading…', async () => void (s.products = (await client.list(WINDOWS[s.window]!, 50)).products))
  app.on('key', (event: any) => {
    const action = onKey(s, event)
    if (action === 'quit') app.quit()
    else if (action === 'load') void load()
    else if (action === 'karma') {
      void run('Loading the karma board…', async () => {
        const week = await client.leaderboard('karma', 'week', 25)
        s.board = week.rows.length ? week : await client.leaderboard('karma', 'all', 25)
      })
    }
    else if (action === 'vote') {
      const p = s.products[s.at]!
      void run('Voting…', async () => {
        const r = await client.vote(p.slug)
        p.votes = r.votes
        s.flash = r.counted ? `▲ ${p.name}: thanks!` : `You already voted for ${p.name}.`
      })
    } else if (action === 'launch') {
      const url = s.typing!.trim()
      s.typing = null
      void run(`Reading ${url}…`, async () => {
        const r = await client.launch(url)
        s.flash = r.existing ? `${r.product.name} is already here.` : `Launched ${r.product.name}. Yours? builtindie claim ${r.product.slug}`
        s.window = WINDOWS.indexOf('new')
        s.products = (await client.list('new', 50)).products
        s.at = 0
      })
    }
    app.invalidate()
  })
  app.render(({ ui, theme }: any) => {
    ui.row({ size: 1 }, (h: any) => {
      h.text(' built.indie', { fg: theme.accent, bold: true, size: 13 })
      h.text(WINDOWS.map((w, i) => (i === s.window ? `[${w}]` : w)).join('  '), { fg: theme.text })
      h.text(`${client.base.replace(/^https?:\/\//, '')} `, { fg: theme.muted, align: 'right' })
    })
    if (s.board) {
      const r = s.board
      ui.panel({ title: `Top karma (${r.period === 'all' ? 'all time' : 'this week'})` }, (b: any) => {
        if (!r.rows.length) b.text('Nobody yet. Sign in at built.indie, then upvote, review, comment and share to earn karma.', { fg: theme.muted })
        for (const x of r.rows) b.text(`${String(x.rank ?? '').padStart(3)}. ${String(x.value).padStart(5)}  ${x.name} ${x.badges.map((g) => g.emoji).join('')}`, { fg: x.rank === 1 ? theme.accent : theme.text, bold: x.rank === 1 })
        b.text(r.web, { fg: theme.muted })
      })
    } else if (s.open) {
      const p = s.open
      ui.panel({ title: `${p.name}  ${UP} ${p.votes}` }, (b: any) => {
        b.text(p.tagline, { fg: theme.accent, bold: true })
        b.text(p.description || '', { fg: theme.text })
        b.text(`site   ${p.url}`, { fg: theme.muted })
        b.text(`page   ${p.page}`, { fg: theme.muted })
        if (p.tags.length) b.text(`tags   ${p.tags.join(', ')}`, { fg: theme.muted })
        if (p.videos.length) b.text(`video  ${p.videos[0]!.url}`, { fg: theme.muted })
        if (p.maker) b.text(`maker  ${p.maker.name}${p.maker.verified ? ' ✓' : ''}`, { fg: theme.muted })
        if (p.rating != null) b.text(`rated  ★ ${p.rating} from ${p.reviews}`, { fg: theme.muted })
      })
    } else {
      ui.panel({ title: s.busy ?? `${WINDOWS[s.window]} (${s.products.length})` }, (b: any) => {
        if (!s.products.length) b.text(s.busy ? '' : 'Nothing here yet. Press l to launch yours.', { fg: theme.muted })
        s.products.slice(Math.max(0, s.at - 15), Math.max(0, s.at - 15) + 30).forEach((p) => {
          const i = s.products.indexOf(p)
          b.text(`${i === s.at ? '›' : ' '} ${String(i + 1).padStart(2)}  ${UP}${String(p.votes).padStart(4)}  ${p.name}${p.verified ? ` ${OK}` : ''}  ${p.tagline}`, { fg: i === s.at ? theme.accent : theme.text, bold: i === s.at })
        })
      })
    }
    if (s.typing !== null) ui.panel({ title: 'Launch a URL', size: 3 }, (b: any) => b.text(`${s.typing}▏`, { fg: theme.accent }))
    else if (s.flash) ui.panel({ title: 'built.indie', size: 3 }, (b: any) => b.text(s.flash, { fg: theme.accent }))
    ui.statusBar({ items: s.typing !== null ? [{ key: 'Enter', label: 'launch' }, { key: 'Esc', label: 'cancel' }] : [{ key: '←→', label: 'board' }, { key: '↑↓', label: 'pick' }, { key: 'Enter', label: 'open' }, { key: 'v', label: 'upvote' }, { key: 'l', label: 'launch' }, { key: 'k', label: 'karma' }, { key: 'q', label: 'quit' }], right: [{ label: 'built.indie' }] })
  })
  void load()
  await app.start()
}
