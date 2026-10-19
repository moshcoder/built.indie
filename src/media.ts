/**
 * Pictures we keep: a product's logo, its card image, its screenshots and one
 * screenshot of the homepage we take ourselves. Hot-linking breaks the day a
 * maker redesigns, and our CSP allows images only from ourselves, so every
 * picture is downloaded once, checked by its first bytes, and served from
 * /m/<product>/<file>.
 *
 * The homepage screenshot is headless Chrome. When we run as root it runs as
 * `nobody`, with its own throwaway profile, so a hostile page renders with no
 * privileges; Chrome's Local Network Access keeps the page off our loopback.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeUrl, safeFetch, type FetchOptions } from './fetch.js'

export const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
}

/** The image kind by its first bytes, or null when it is not a picture we serve. */
export function sniff(b: Uint8Array): string | null {
  const at = (i: number, ...v: number[]) => v.every((x, j) => b[i + j] === x)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'jpg'
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'gif'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'webp'
  if (at(4, 0x66, 0x74, 0x79, 0x70) && /^(avif|avis)/.test(String.fromCharCode(...b.slice(8, 12)))) return 'avif'
  if (at(0, 0x00, 0x00, 0x01, 0x00)) return 'ico'
  const head = new TextDecoder().decode(b.slice(0, 512)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg'
  return null
}

/** Pixel size of a PNG, JPEG, GIF or WebP from its header; null when we cannot tell. */
export function dimensions(b: Uint8Array, kind: string): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  try {
    if (kind === 'png') return { width: v.getUint32(16), height: v.getUint32(20) }
    if (kind === 'gif') return { width: v.getUint16(6, true), height: v.getUint16(8, true) }
    if (kind === 'webp') {
      const chunk = String.fromCharCode(...b.slice(12, 16))
      if (chunk === 'VP8 ') return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff }
      if (chunk === 'VP8L') {
        const bits = v.getUint32(21, true)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (chunk === 'VP8X') return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) }
    }
    if (kind === 'jpg') {
      let i = 2
      while (i < b.length - 9) {
        if (b[i] !== 0xff) return null
        const marker = b[i + 1]!
        const len = v.getUint16(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: v.getUint16(i + 7), height: v.getUint16(i + 5) }
        i += 2 + len
      }
    }
  } catch {}
  return null
}

export type Saved = { file: string; width: number | null; height: number | null }

export class Media {
  constructor(readonly dir: string) {}

  path(productId: string, file: string): string {
    return join(this.dir, productId, file)
  }

  /** Download one picture into the product's folder. Null when it is missing, too big or not an image. */
  async save(productId: string, name: string, url: string | null, o: FetchOptions & { minSide?: number } = {}): Promise<Saved | null> {
    if (!url) return null
    try {
      const r = await safeFetch(url, { ...o, accept: 'image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8', maxBytes: 6 * 1024 * 1024, timeoutMs: 10_000 })
      if (r.status >= 300) return null
      const kind = sniff(r.body)
      if (!kind) return null
      const size = dimensions(r.body, kind)
      if (o.minSide && size && Math.min(size.width, size.height) < o.minSide) return null
      return await this.write(productId, `${name}.${kind}`, r.body, size)
    } catch {
      return null
    }
  }

  async write(productId: string, file: string, body: Uint8Array, size: { width: number; height: number } | null = null): Promise<Saved> {
    await mkdir(join(this.dir, productId), { recursive: true })
    await writeFile(this.path(productId, file), body)
    return { file, width: size?.width ?? null, height: size?.height ?? null }
  }

  async read(productId: string, file: string): Promise<Uint8Array | null> {
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(productId) || !/^[a-z0-9-]{1,40}\.(png|jpg|gif|webp|avif|ico|svg)$/.test(file)) return null
    try {
      return new Uint8Array(await readFile(this.path(productId, file)))
    } catch {
      return null
    }
  }

  async remove(productId: string): Promise<void> {
    if (/^[A-Za-z0-9_-]{6,40}$/.test(productId)) await rm(join(this.dir, productId), { recursive: true, force: true })
  }
}

const CHROMES = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']

export function findChrome(): string | null {
  const own = process.env.BUILTINDIE_CHROME
  if (own === 'off') return null
  if (own) return own
  return CHROMES.find((c) => existsSync(c)) ?? null
}

let queue: Promise<unknown> = Promise.resolve()

/** A 1280×800 PNG of the page, or null. One at a time: Chrome is the heaviest thing we run. */
export function screenshot(url: string, chrome = findChrome(), timeoutMs = 35_000): Promise<Uint8Array | null> {
  if (!chrome) return Promise.resolve(null)
  const target = normalizeUrl(url).href
  const run = async (): Promise<Uint8Array | null> => {
    const dir = await mkdtemp(join(tmpdir(), 'builtindie-shot-'))
    try {
      const root = process.getuid?.() === 0
      if (root) await chmod(dir, 0o777)
      const args = [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run', '--no-default-browser-check',
        '--disable-extensions', '--disable-sync', '--disable-background-networking', '--deny-permission-prompts',
        `--user-data-dir=${join(dir, 'profile')}`, '--window-size=1280,800', '--virtual-time-budget=6000', `--screenshot=${join(dir, 'shot.png')}`, target,
      ]
      // runuser lives in /usr/sbin, which a service's PATH often leaves out.
      const runuser = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'].find((p) => existsSync(p)) ?? 'runuser'
      const [cmd, argv] = root ? [runuser, ['-u', 'nobody', '--', '/usr/bin/env', `HOME=${dir}`, chrome, ...args]] : [chrome, args]
      await new Promise<void>((resolve) => {
        const child = spawn(cmd, argv as string[], { stdio: 'ignore' })
        const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
        child.on('exit', () => (clearTimeout(timer), resolve()))
        child.on('error', () => (clearTimeout(timer), resolve()))
      })
      const png = new Uint8Array(await readFile(join(dir, 'shot.png')).catch(() => Buffer.alloc(0)))
      return sniff(png) === 'png' ? png : null
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
  const next = queue.then(run, run)
  queue = next.catch(() => null)
  return next
}
