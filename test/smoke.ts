// Live check against real sites: bun test/smoke.ts linear.app logicsrc.com
import { autofetch } from '../src/fetch.ts'

for (const u of process.argv.slice(2)) {
  const t = Date.now()
  try {
    const r = await autofetch(u)
    console.log(u, `${Date.now() - t}ms`, JSON.stringify({ ...r, jsonld: r.jsonld.length, cards: Object.keys(r.cards) }, null, 1))
  } catch (e) {
    console.log(u, 'ERR', (e as Error).message)
  }
}
