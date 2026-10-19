/**
 * Icons from the OpenIcon reference set (logicsrc.com/docs/openicon,
 * github.com/profullstack/openicon), vendored in public/icons: the SVGs we
 * draw and a trimmed openicon.json that keeps each entry as published,
 * brand trademark notes included.
 *
 * On a page an icon is inline SVG in currentColor, so it takes the text colour
 * and needs no extra request or CSP rule. In a terminal it is the best glyph the
 * terminal can draw, by the spec's rule 6: OPENICON_GLYPHS, then NERD_FONT=1,
 * then a UTF-8 locale for Unicode, else ASCII.
 */
import { readdirSync, readFileSync } from 'node:fs'

type Entry = { key: string; name: string; aliases?: string[]; brand?: boolean; tui?: { nerd?: string; unicode?: string; ascii?: string } }

const DIR = new URL('../public/icons/', import.meta.url)
const set = JSON.parse(readFileSync(new URL('openicon.json', DIR), 'utf8')) as { icons: Entry[] }
const byName = new Map<string, Entry>()
for (const e of set.icons) for (const n of [e.key, ...(e.aliases ?? [])]) if (!byName.has(n)) byName.set(n, e)

const svgs = new Map<string, string>()
for (const file of readdirSync(new URL('svg/', DIR))) {
  if (!file.endsWith('.svg')) continue
  const raw = readFileSync(new URL(`svg/${file}`, DIR), 'utf8')
  // Decorative beside a text label: no <title>, hidden from screen readers.
  svgs.set(file.slice(0, -4), raw.replace(/<title>[^<]*<\/title>/, '').replace('<svg ', '<svg class="i" aria-hidden="true" focusable="false" width="1em" height="1em" '))
}

/** An icon by key or alias, as inline SVG; empty when the set has none. */
export function icon(name: string): string {
  const e = byName.get(name)
  return (e && svgs.get(e.key)) ?? ''
}

export const ICON_KEYS = [...svgs.keys()]

/** Our social kinds (fetch.ts) to OpenIcon keys. */
export const SOCIAL_ICONS: Record<string, string> = { x: 'x', github: 'github', linkedin: 'linkedin', discord: 'discord', youtube: 'youtube', bluesky: 'bluesky', instagram: 'instagram', tiktok: 'tiktok', reddit: 'reddit', telegram: 'telegram', producthunt: 'product-hunt', appstore: 'apple', chrome: 'chrome', playstore: 'globe' }

export type GlyphMode = 'nerd' | 'unicode' | 'ascii'

export function glyphMode(env: Record<string, string | undefined> = process.env): GlyphMode {
  const own = env.OPENICON_GLYPHS
  if (own === 'nerd' || own === 'unicode' || own === 'ascii') return own
  if (env.NERD_FONT === '1') return 'nerd'
  return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '') ? 'unicode' : 'ascii'
}

/** The best terminal glyph for an icon, falling back nerd → unicode → ascii. */
export function glyph(name: string, mode: GlyphMode = glyphMode()): string {
  const t = byName.get(name)?.tui
  if (!t) return ''
  if (mode === 'nerd' && t.nerd) return t.nerd
  if (mode !== 'ascii' && t.unicode) return t.unicode
  return t.ascii ?? ''
}
