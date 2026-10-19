/**
 * Tags: one shape for every tag, and topics inferred from a listing's own words
 * when its homepage declares none (no keywords meta, JSON-LD category or
 * opensite.json tags). Inference is a fixed vocabulary, so it is cheap,
 * offline and the same on every run.
 */

export const MAX_TAGS = 6

/** Lower case, no leading #, only a-z 0-9 space + # . -, 2 to 24 characters; null if nothing is left. */
export function normalizeTag(raw: string): string | null {
  const t = String(raw)
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/application$/, '')
    .replace(/[^a-z0-9 +#.-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length >= 2 && t.length <= 24 ? t : null
}

/** Normalized, unique, at most `max`. */
export function cleanTags(raw: Iterable<string>, max = MAX_TAGS): string[] {
  const out = new Set<string>()
  for (const r of raw) {
    const t = normalizeTag(r)
    if (t) out.add(t)
    if (out.size >= max) break
  }
  return [...out]
}

/** Topic, and the words that mean it. Earlier topics win a tie. */
const TOPICS: [string, RegExp][] = [
  ['ai', /\b(ai|llms?|gpt|claude|codex|opencode|agentic|ai agents?|open models?|whisper(\.cpp)?)\b/g],
  ['agents', /\b(agents?|agentic)\b/g],
  ['developer tools', /\b(developers?|cli|apis?|sdk|codebase|coding|git|webhooks?|npm|registry|registries|ci\/?cd)\b/g],
  ['game', /\b(games?|gaming|gamers?|play|shooter|multiplayer|co-op|campaign)\b/g],
  ['tactical', /\b(operatives?|tactical|combat|military|war)\b/g],
  ['sports', /\b(sports?|youth-sports|athletes?|league|fixtures|teams? in the world)\b/g],
  ['crypto', /\b(crypto|bitcoin|btc|eth|usdc|sol|stablecoins?|lightning|web3|wallets?|coinpay)\b/g],
  ['payments', /\b(payments?|checkout|pay link|get paid|pays you|invoices?|billing|pay by the)\b/g],
  ['sms', /\b(sms|texts?|texting|phone numbers?|sim( cards?)?|carrier)\b/g],
  ['verification', /\b(otp|2fa|verification( codes?)?|one-time codes?)\b/g],
  ['email', /\b(e-?mail|newsletters?|inbox)\b/g],
  ['voice', /\b(voice|calls?|dials?|phone tree|on hold)\b/g],
  ['customer support', /\b(customer support|phone tree|helpdesk|support tickets?)\b/g],
  ['video', /\b(videos?|reels?|films?|demo video|highlight)\b/g],
  ['tv', /\b(iptv|tv( guide)?|live-tv|channels?|m3u|xtream)\b/g],
  ['music', /\b(music|spotify|albums?|songs?|genres?)\b/g],
  ['audio', /\b(audio|podcasts?|recordings?|transcripts?|transcri\w+)\b/g],
  ['news', /\b(news|newsrooms?|headlines|journalism|the desk)\b/g],
  ['alerts', /\b(reminders?|alerts?|notifications?|get told|never miss|before it drops)\b/g],
  ['jobs', /\b(jobs?|hiring|freelanc\w*|gigs?|careers?)\b/g],
  ['health', /\b(health|telehealth|medical|patients?|clinics?|prescriptions?|labs)\b/g],
  ['food', /\b(recipes?|cookbooks?|food|cooking|ingredients)\b/g],
  ['cannabis', /\b(cannabis|dispensar(y|ies)|weed)\b/g],
  ['directory', /\b(directory|directories|listings?|search engine|compared)\b/g],
  ['data', /\b(database|datasets?|structured data|feeds?|json|real-time public data)\b/g],
  ['marketing', /\b(ads|advertis\w*|promot\w*|seo|marketing|launch sites|submissions?)\b/g],
  ['automation', /\b(automat\w*|workflows?|deterministic)\b/g],
  ['open source', /\b(open-source|open source|foss|self-host\w*)\b/g],
  ['security', /\b(security|malware|encrypt\w*|vulnerab\w*|privacy|audit)\b/g],
  ['photos', /\b(photos?|images?|pictures?|backgrounds?|camera)\b/g],
  ['terminal', /\b(terminal|ssh|tmux|bbs|bulletin board)\b/g],
  ['no-code', /\b(no-code|your own words|describe what you want)\b/g],
  ['open standards', /\b(standards|schemas?|specs?|conventions|primitives)\b/g],
  ['shopping', /\b(shop|buy|marketplace|e-?commerce|store)\b/g],
  ['art', /\b(tattoos?|artistry|artist)\b/g],
  ['automotive', /\b(auto detailing|cars?|automotive)\b/g],
  ['cigars', /\b(cigars?|spliffs?|tobacco)\b/g],
  ['events', /\b(events?|meetups?|herf|every other sunday)\b/g],
  ['productivity', /\b(productivity|organi[sz]e|searchable|right folder)\b/g],
]

/** Up to `max` topics the text is about, most mentioned first. */
export function inferTags(text: string, max = 4): string[] {
  const t = ` ${text.toLowerCase()} `
  return TOPICS.map(([tag, re], i) => ({ tag, i, n: t.match(re)?.length ?? 0 }))
    .filter((s) => s.n > 0)
    // "never miss a game" is a match, not a video game.
    .filter((s, _, all) => s.tag !== 'game' || !all.some((o) => o.tag === 'sports'))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .slice(0, max)
    .map((s) => s.tag)
}

/** What a listing is tagged with: its declared tags, else topics from its name, tagline and description. */
export function tagsFor(declared: string[], text: { name?: string; tagline?: string; description?: string }): string[] {
  const own = cleanTags(declared)
  return own.length ? own : inferTags([text.name, text.tagline, text.description].filter(Boolean).join('. '))
}
