/**
 * `builtindie mcp`: built.indie for an agent, on stdio.
 *
 *   claude mcp add builtindie -- bunx @profullstack/builtindie mcp
 *
 * Reading, launching and voting need nothing. Claiming and editing need
 * BUILTINDIE_KEY: an account API key from built.indie.pit.world/me.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { BuiltIndieClient, type SearchFilters } from './client.js'
import { VERSION } from './version.js'

const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] })
const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] })
const slug = z.string().min(1).max(60).describe('A product slug, e.g. linear (built.indie/p/linear)')
const wrap = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a))
  } catch (e) {
    return failure(e)
  }
}

export function createMcpServer(client = new BuiltIndieClient()): McpServer {
  const server: any = new McpServer({ name: 'built.indie', version: VERSION })
  server.tool(
    'launch_product',
    'Launch a product on built.indie from its URL. We read the homepage (meta tags, Open Graph, JSON-LD, llms.txt, opensite.json, openprofile.md), save the logo and screenshots and put it on today\'s board. Free. To edit it later, the domain owner claims it (claim_product).',
    {
      url: z.string().min(3).describe('The product homepage, e.g. yourproduct.com'),
      maker_name: z.string().max(60).optional(),
      maker_profile: z.string().optional().describe("The maker's OpenProfile.md URL (logicsrc.com/openprofile)"),
      tagline: z.string().max(90).optional().describe('Override the tagline we find'),
      publish: z.boolean().optional().describe('Go live now (default true); false leaves a draft to check'),
    },
    wrap((a: { url: string; maker_name?: string; maker_profile?: string; tagline?: string; publish?: boolean }) => client.launch(a.url, { makerName: a.maker_name, makerProfile: a.maker_profile, tagline: a.tagline, publish: a.publish })),
  )
  server.tool('preview_site', 'Read any site the way built.indie does (name, tagline, description, logo, screenshots, videos, socials, llms.txt, OpenProfile) without saving anything.', { url: z.string().min(3) }, wrap((a: { url: string }) => client.preview(a.url)))
  server.tool(
    'list_products',
    'Products launched on built.indie, best first: today, week, month, all, new (newest first) or featured.',
    { window: z.enum(['today', 'week', 'month', 'all', 'new', 'featured']).default('today'), limit: z.number().int().min(1).max(100).default(20) },
    wrap((a: { window: string; limit: number }) => client.list(a.window, a.limit)),
  )
  server.tool('get_product', 'Everything about one launch: description, pictures, videos, socials, maker, votes, award.', { slug }, wrap((a: { slug: string }) => client.product(a.slug)))
  server.tool('list_tags', 'Every tag on built.indie with how many launches carry it, most used first.', {}, wrap(() => client.tags()))
  server.tool(
    'tagged',
    'Launches with one exact tag (from list_tags), best first.',
    { tag: z.string().min(2).max(24), limit: z.number().int().min(1).max(100).default(20) },
    wrap((a: { tag: string; limit: number }) => client.tagged(a.tag, a.limit)),
  )
  server.tool(
    'search',
    'Search and filter launches. Words match name, tags, category, domain, tagline, maker, stack and description. Narrow with categories (see list_categories), tags, has (verified, claimed, featured, video, screenshots, llms, opensite, openprofile, openstack, opensaas, maker), stack, maker and launched. The answer carries facets: counts for each value, to narrow further.',
    {
      query: z.string().max(80).default(''),
      category: z.array(z.string()).max(10).optional().describe('Category keys, e.g. developer-tools, ai, crypto, security (any of them)'),
      tag: z.array(z.string()).max(10).optional().describe('Tags (any of them)'),
      has: z.array(z.string()).max(10).optional().describe('Every one must hold: verified, claimed, featured, video, screenshots, llms, opensite, openprofile, openstack, opensaas, maker'),
      stack: z.array(z.string()).max(10).optional().describe('Built with (from the product\'s OpenStack.md)'),
      maker: z.array(z.string()).max(10).optional(),
      launched: z.enum(['today', 'week', 'month', 'year']).optional(),
      sort: z.enum(['relevance', 'top', 'new', 'name']).optional(),
      page: z.number().int().min(1).max(500).optional(),
      limit: z.number().int().min(1).max(100).default(20),
    },
    wrap(({ query, ...filters }: { query: string } & SearchFilters) => client.search(query, filters)),
  )
  server.tool('list_categories', 'Every category and tag on built.indie, with how many launches each has.', {}, wrap(() => client.categories()))
  server.tool('upvote', 'Upvote a product (one vote per visitor).', { slug }, wrap((a: { slug: string }) => client.vote(a.slug)))
  server.tool(
    'edit_product',
    'Change a launch you claimed or submitted (needs BUILTINDIE_KEY). Any field left out stays as it is. refetch reads the homepage again; publish puts a draft live.',
    {
      slug,
      name: z.string().max(60).optional(),
      tagline: z.string().max(90).optional(),
      description: z.string().max(1200).optional(),
      tags: z.array(z.string()).max(6).optional(),
      videos: z.array(z.string()).max(4).optional().describe('YouTube, Vimeo, Loom or .mp4 links'),
      action: z.enum(['save', 'refetch', 'publish']).default('save'),
    },
    wrap(async (a: { slug: string; action: string; name?: string; tagline?: string; description?: string; tags?: string[]; videos?: string[] }) => {
      if (a.action !== 'save') return client.act(a.slug, a.action as 'publish' | 'refetch')
      return client.edit(a.slug, { name: a.name, tagline: a.tagline, description: a.description, tags: a.tags, videos: a.videos })
    }),
  )
  server.tool(
    'claim_product',
    'Claim a listing for its domain owner (needs BUILTINDIE_KEY). Two proofs, either works. Easiest: put the `badge` HTML on the product homepage; it is <img src="https://built.indie.pit.world/images.svg?id=<id>"> with an id unique to this listing and this account, and it also earns the followed link and the ✓. Or add the DNS TXT `record`. Also returns `markdown`: step-by-step instructions for whoever has site or DNS access. Call again once either is live; claimed comes back true with `method` badge or dns.',
    { slug },
    wrap((a: { slug: string }) => client.claim(a.slug)),
  )
  server.tool('my_products', 'Your launches and claims (needs BUILTINDIE_KEY).', {}, wrap(() => client.me()))
  server.tool('my_invites', 'Your invite link and credits (needs BUILTINDIE_KEY). Each new member who signs up through the link and launches a listing earns one credit: a free Featured week.', {}, wrap(() => client.invites()))
  server.tool('feature_with_credit', 'Spend one invite credit to feature a listing you own for a week (needs BUILTINDIE_KEY).', { slug }, wrap((a: { slug: string }) => client.credit(a.slug)))
  return server
}

export async function runMcp(client = new BuiltIndieClient()): Promise<void> {
  await createMcpServer(client).connect(new StdioServerTransport())
}
