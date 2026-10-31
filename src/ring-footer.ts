/**
 * built.indie's footer: its links, the << Profullstack >> webring nav and the
 * copyright line, from @profullstack/footer. It is rendered into the HTML on the
 * server because rssamplifier's ring verifier reads the page and never runs script.
 *
 * Pages render synchronously, so the footer is kept as a string: the bundled
 * template at boot, then the @latest template from the CDN, refreshed every 15
 * minutes (a footer release reaches us with no redeploy). A failed refresh keeps
 * the last good copy. Our CSP allows inline styles, so the template CSS stays on.
 */
import { escapeHtml as escapeFooterHtml, footerHtml, footerHtmlSync } from '@profullstack/footer'

type FooterOptions = Parameters<typeof footerHtmlSync>[0]
const SITE = 'https://built.indie.pit.world/'
const CURRENT_LISTING_HREF = `${SITE}__CURRENT_LISTING__`

export function ringFooterOptions(links: { label: string; href: string }[]): FooterOptions {
  return {
    site: SITE,
    links,
    since: 2026,
    tagline: 'Free, open source (MIT)',
    pwamartHref: 'https://pwamart.com/publishers/profullstack',
    // Replaced per request so product pages point their badge to their own listing.
    builtIndieHref: CURRENT_LISTING_HREF,
  }
}

let options: FooterOptions | null = null
let html = ''

export function setRingFooterOptions(next: FooterOptions): void {
  options = next
  html = footerHtmlSync(next)
}

/** The footer markup, with the built.indie badge pointing at this page's listing when there is one. */
export function ringFooter(path = '/'): string {
  const slug = /^\/p\/([a-z0-9-]+)(?:\/|$)/i.exec(path)?.[1]
  const href = slug ? `${SITE}p/${slug}` : SITE
  return html.replace(`href="${CURRENT_LISTING_HREF}"`, `href="${escapeFooterHtml(href)}"`)
}

/** Accept a rendered footer only when it still links the ring. */
export function setRingFooter(next: unknown): boolean {
  if (typeof next !== 'string' || !next.includes('/ring/profullstack') || next.length > 64_000) return false
  html = next
  return true
}

export function startRingFooterRefresh(everyMs = 15 * 60_000): () => void {
  const run = () => {
    if (!options) return
    footerHtml(options).then(setRingFooter, () => {})
  }
  run()
  const timer = setInterval(run, everyMs)
  ;(timer as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
