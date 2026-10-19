/**
 * builtindie: built.indie from the terminal.
 *
 *   builtindie                         the TUI: today's board, vote, launch
 *   builtindie launch <url>            launch it: free, live at once
 *   builtindie top [today|week|month|all|new]
 *   builtindie show <slug>
 *   builtindie vote <slug>
 *   builtindie preview <url>           what we would read from a site, nothing saved
 *   builtindie search [words] [--category k] [--tag t] [--has h] [--sort top|new|name]
 *   builtindie categories              every category and tag, with counts
 *   builtindie claim <slug>            prove you own the domain (the badge or DNS TXT), BUILTINDIE_KEY
 *   builtindie me                      your launches, BUILTINDIE_KEY
 *   builtindie invite                  your invite link and free Featured credits, BUILTINDIE_KEY
 *   builtindie credit <slug>           spend a credit: feature a listing you own, BUILTINDIE_KEY
 *   builtindie edit <slug> --tagline … (BUILTINDIE_KEY)
 *   builtindie refetch <slug>          (BUILTINDIE_KEY)
 *   builtindie mcp                     MCP server on stdio
 *   builtindie serve [--port N]        run your own built.indie
 */
import { BuiltIndieClient, type ApiProduct } from './client.js'
import { VERSION } from './version.js'

export const HELP = `builtindie ${VERSION}: launch your indie product with one URL (https://built.indie.pit.world)

  builtindie                          interactive (TUI)
  builtindie launch <url>             launch it, free; we fetch logo, screenshots, videos, llms.txt
        [--maker "Name"] [--profile <openprofile.md url>] [--tagline "…"] [--draft]
  builtindie top [today|week|month|all|new|featured]
  builtindie show <slug>
  builtindie vote <slug>
  builtindie preview <url>            what we read from a site; nothing is saved
  builtindie search [words]           search; narrow with --category developer-tools --tag ai
        [--has verified,video] [--stack Bun] [--maker "Name"] [--launched today|week|month|year]
        [--sort relevance|top|new|name] [--page N] [--facets]
  builtindie categories               every category and tag, with how many launches each
  builtindie claim <slug> [--md]      your badge for the homepage (or the DNS TXT record) that proves
                                      it is yours, then checks both; --md prints the steps as Markdown
                                      to paste to an AI with DNS or site access
  builtindie me                       your launches
  builtindie invite                   your invite link; each maker it brings in who launches = a free Featured week
  builtindie credit <slug>            spend a credit to feature a listing you own
  builtindie edit <slug> [--name --tagline --description --tags a,b --video URL]
  builtindie refetch <slug>           read the homepage again
  builtindie publish <slug>           put a draft live
  builtindie verify <slug>            check the badge is on your homepage
  builtindie mcp                      MCP server: claude mcp add builtindie -- bunx @profullstack/builtindie mcp
  builtindie serve [--port N]         run your own instance

  --json                              machine-readable output
  BUILTINDIE_KEY=bi_…                 your API key from built.indie.pit.world/me (claim, edit, me)
  BUILTINDIE_URL=https://…            another instance (default https://built.indie.pit.world)
`

type Out = { log(text: string): void; error(text: string): void }

/** --name value pairs and bare words, in order. */
export function parseArgs(argv: string[]): { words: string[]; flags: Record<string, string | true> } {
  const words: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s) as [string, string | undefined]
      if (v !== undefined) flags[k] = v
      else if (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--') && !['json', 'draft', 'md', 'facets'].includes(k)) flags[k] = argv[++i]!
      else flags[k] = true
    } else words.push(a)
  }
  return { words, flags }
}

export const line = (p: ApiProduct, rank?: number) => `${rank ? `${String(rank).padStart(2)}. ` : ''}▲${String(p.votes).padStart(4)}  ${p.name}${p.verified ? ' ✓' : ''}: ${p.tagline || p.domain}  ${p.page}`

export function describe(p: ApiProduct): string {
  return [
    `${p.name}${p.verified ? ' ✓' : ''}  ▲ ${p.votes}${p.award ? `  🏆 #${p.award.rank} of ${p.award.day}` : ''}`,
    p.tagline,
    '',
    p.description,
    '',
    `site       ${p.url}`,
    `page       ${p.page}`,
    p.tags.length ? `tags       ${p.tags.join(', ')}` : '',
    p.logo ? `logo       ${p.logo}` : '',
    [p.screenshot, ...p.images].filter(Boolean).length ? `pictures   ${[p.screenshot, p.card_image, ...p.images].filter(Boolean).join('\n           ')}` : '',
    p.videos.length ? `videos     ${p.videos.map((v) => v.url).join('\n           ')}` : '',
    Object.keys(p.socials).length ? `socials    ${Object.entries(p.socials).map(([k, v]) => `${k}: ${v}`).join('\n           ')}` : '',
    p.llms ? `llms.txt   ${p.llms.url}` : '',
    p.profile ? `profile    ${p.profile.url} (${p.profile.kind ?? 'openprofile'})` : '',
    p.maker ? `maker      ${p.maker.name}${p.maker.verified ? ' ✓' : ''}${p.maker.profile ? `  ${p.maker.profile}` : ''}` : '',
    `badge      ${p.badge}`,
  ]
    .filter((l, i, all) => l !== '' || (all[i - 1] !== '' && i > 0))
    .join('\n')
}

export async function main(argv = process.argv.slice(2), out: Out = console, client = new BuiltIndieClient()): Promise<number> {
  const { words, flags } = parseArgs(argv)
  const json = Boolean(flags.json)
  const [command, ...rest] = words
  const show = (value: unknown, text: string) => out.log(json ? JSON.stringify(value, null, 2) : text)
  const str = (k: string) => (typeof flags[k] === 'string' ? (flags[k] as string) : undefined)
  try {
    if (!command) {
      if (!process.stdout.isTTY) return out.log(HELP), 0
      const { runTui } = await import('./tui.js')
      await runTui(client)
      return 0
    }
    switch (command) {
      case 'help':
      case '--help':
        out.log(HELP)
        return 0
      case 'version':
        out.log(VERSION)
        return 0
      case 'mcp': {
        const { runMcp } = await import('./mcp.js')
        await runMcp(client)
        return 0
      }
      case 'serve': {
        const { serve } = await import('./server.js')
        const s = serve(str('port') ? { port: Number(str('port')) } : {})
        out.log(`built.indie listening on http://${s.hostname}:${s.port}`)
        return await new Promise<number>(() => {})
      }
      case 'launch':
      case 'submit': {
        if (!rest[0]) throw new Error('builtindie launch <url>')
        const r = await client.launch(rest[0], { makerName: str('maker'), makerProfile: str('profile'), name: str('name'), tagline: str('tagline'), description: str('description'), tags: str('tags')?.split(','), videos: str('video') ? [str('video')!] : undefined, publish: !flags.draft })
        if (r.existing) return show(r, `Already launched:\n${line(r.product)}`), 0
        show(r, `${describe(r.product)}\n\n${r.product.status === 'live' ? 'Live. Share it and add the badge.' : `Draft: builtindie publish ${r.product.slug}`}\nYours? builtindie claim ${r.product.slug}  (${r.claim_url})`)
        return 0
      }
      case 'top':
      case 'list':
      case 'new': {
        const w = command === 'new' ? 'new' : (rest[0] ?? 'today')
        const r = await client.list(w, Number(str('limit') ?? 30))
        show(r, r.products.map((p, i) => line(p, w === 'new' ? undefined : i + 1)).join('\n') || `Nothing launched ${w === 'today' ? 'today yet' : 'here yet'}.`)
        return 0
      }
      case 'search': {
        const many = (k: string) => (typeof flags[k] === 'string' ? String(flags[k]).split(',').map((v) => v.trim()).filter(Boolean) : undefined)
        const r = await client.search(rest.join(' '), { category: many('category'), tag: many('tag'), has: many('has'), stack: many('stack'), maker: typeof flags.maker === 'string' ? [flags.maker] : undefined, launched: str('launched'), sort: str('sort'), page: Number(str('page') ?? 1) || 1, limit: Number(str('limit') ?? 30) || 30 })
        const facets = flags.facets && r.facets ? `\n\n${Object.entries(r.facets).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.map((f) => `${f.value} (${f.count})`).join(', ')}`).join('\n')}` : ''
        show(r, `${r.products.map((p) => line(p)).join('\n') || 'Nothing matches.'}\n\n${r.total} match${r.total === 1 ? '' : 'es'}${r.pages > 1 ? `, page ${r.page} of ${r.pages}` : ''} · ${r.web}${facets}`)
        return 0
      }
      case 'categories': {
        const r = await client.categories()
        show(r, `${r.categories.map((c) => `${String(c.count).padStart(4)}  ${c.label} (${c.key})`).join('\n')}\n\nTags: ${r.tags.map((t) => `${t.tag} (${t.count})`).join(', ')}`)
        return 0
      }
      case 'show': {
        const p = await client.product(rest[0] ?? '')
        show(p, describe(p))
        return 0
      }
      case 'vote': {
        const r = await client.vote(rest[0] ?? '')
        show(r, r.counted ? `▲ ${r.votes}: thanks!` : `▲ ${r.votes}: you already voted.`)
        return 0
      }
      case 'preview': {
        const r = await client.preview(rest[0] ?? '')
        show(r, JSON.stringify(r, null, 2))
        return 0
      }
      case 'edit': {
        const patch: Record<string, unknown> = {}
        for (const k of ['name', 'tagline', 'description']) if (str(k) !== undefined) patch[k] = str(k)
        if (str('tags') !== undefined) patch.tags = str('tags')!.split(',')
        if (str('video') !== undefined) patch.videos = [str('video')]
        if (str('maker') !== undefined) patch.maker_name = str('maker')
        if (str('profile') !== undefined) patch.maker_profile = str('profile')
        const p = await client.edit(rest[0] ?? '', patch, str('key'))
        show(p, describe(p))
        return 0
      }
      case 'refetch':
      case 'publish': {
        const p = await client.act(rest[0] ?? '', command, str('key'))
        show(p, describe(p))
        return 0
      }
      case 'claim': {
        const slug = rest[0] ?? ''
        if (flags.md) {
          const r = await client.claimRecord(slug)
          out.log(json ? JSON.stringify(r, null, 2) : r.markdown)
          return 0
        }
        const r = await client.claim(slug)
        if (r.claimed) return show(r, `${slug} is yours ✓${r.method === 'badge' ? ' (we found your badge)' : r.method === 'dns' ? ' (we found your DNS record)' : ''}. Edit it: builtindie edit ${slug} --tagline "…"`), 0
        show(r, `Prove it either way, then run builtindie claim ${slug} again:\n\n1. Easiest: put this badge on your homepage and deploy (its id is yours; it also earns the followed link and the ✓):\n\n  ${r.badge}\n\n2. Or add this DNS record (wait a minute for it to show):\n\n  type   TXT\n  name   ${r.record.name}\n  value  ${r.record.value}\n\n(not found yet at ${r.looked.join(', ')})`)
        return 1
      }
      case 'me': {
        const r = await client.me()
        show(r, `${r.email}\n${r.products.map((p) => `${line(p)}  ${p.owner ? 'claimed ✓' : p.status === 'draft' ? 'draft' : 'not claimed'}`).join('\n') || 'No launches yet.'}`)
        return 0
      }
      case 'invite':
      case 'invites': {
        const r = await client.invites()
        show(r, `Your invite link: ${r.link}\n${r.invited} joined · ${r.launched} launched · ${r.credits} free Featured week${r.credits === 1 ? '' : 's'} to use (${r.feature_days} days each)${r.credits ? '\nUse one: builtindie credit <slug>' : ''}`)
        return 0
      }
      case 'credit': {
        const r = await client.credit(rest[0] ?? '')
        show(r, `${rest[0]} is Featured until ${r.featured_until.slice(0, 10)} ★  (${r.credits} credit${r.credits === 1 ? '' : 's'} left)`)
        return 0
      }
      case 'verify': {
        const r = await client.verify(rest[0] ?? '')
        show(r, r.verified ? 'Verified ✓: we found the badge.' : 'Not found yet: add the badge HTML to your homepage and deploy.')
        return r.verified ? 0 : 1
      }
    }
    out.error(`builtindie: unknown command "${command}"\n\n${HELP}`)
    return 2
  } catch (error) {
    out.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
