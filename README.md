# built.indie

Launch your indie product with one URL. **https://built.indie.pit.world** (on Moshpit DNS: https://built.indie)

Paste a URL and built.indie reads the homepage the way a careful person would: the name, tagline and description, the logo, the card image, screenshots from the page plus one we take ourselves with headless Chrome, YouTube/Vimeo/Loom/mp4 videos, social accounts, `llms.txt`, the web manifest and JSON-LD. It also reads the [LogicSRC](https://logicsrc.com/specs) files a site may serve about itself:

| file | spec | we show |
| --- | --- | --- |
| `/.well-known/opensite.json` | [OpenSite](https://logicsrc.com/docs/opensite) | what the site says it is; wins over what we scrape; `index.allow: false` is honoured |
| `/.well-known/openprofile.md` | [OpenProfile](https://logicsrc.com/docs/openprofile) | the company (`Kind: organization`) and its accounts |
| `/.well-known/openstack.md` | [OpenStack.md](https://logicsrc.com/docs/openstack) | "Built with" |
| `/.well-known/opensaas.json` | [OpenSaaS](https://logicsrc.com/docs/opensaas) | plans, trial, and the cancel page |
| `/.well-known/openicon.json` | [OpenIcon](https://logicsrc.com/docs/openicon) | that it publishes an icon set |

Then it goes on today's board. People upvote (one per visitor). The board resets at midnight UTC; yesterday's winners get "#1 Product of the day" on their page and badge.

**Free to launch, no account.** Anyone can launch any site. To edit a listing, sign in (an emailed link) and **claim** it by adding a DNS TXT record, `_built-indie.<domain>` → `built-indie-verify=<token>`. A signed-in submitter can edit until the owner claims it.

Viral bits: a live badge with the upvote count (`/badge/<slug>.svg`) that turns a link back into a followed link and a ✓ once we see it on the homepage, share buttons, an OG card per product, RSS, and an optional crypto-paid **Featured** slot (CoinPay).

Every product is published back as an OpenSite record (`/p/<slug>/opensite.json`) and an OpenProfile (`/p/<slug>/openprofile.md`); makers are OpenProfiles too (`/makers/<id>/openprofile.md`). Icons are the [OpenIcon](https://github.com/profullstack/openicon) reference set.

## Surfaces

```sh
curl -fsSL https://built.indie.pit.world/install.sh | sh

builtindie                       # TUI: today's board, ←/→ boards, v upvote, l launch
builtindie launch yourproduct.com
builtindie top week
builtindie show linear
builtindie vote linear
builtindie preview any.site --json
BUILTINDIE_KEY=bi_… builtindie claim linear   # prints the TXT record, then checks it
BUILTINDIE_KEY=bi_… builtindie edit linear --tagline "…"

claude mcp add builtindie -- bunx @profullstack/builtindie mcp
```

The web app is a PWA (manifest + service worker). The JSON API is under `/api/v1` and documented at `/help`; the OpenSite index calls are `GET /api/v1/sites?url=` and `POST /api/v1/sites`.

## Run your own

```sh
bun install
BUILTINDIE_KEY=$(openssl rand -hex 32) bun src/server.ts   # http://127.0.0.1:8798
bun test
```

| env | |
| --- | --- |
| `BUILTINDIE_KEY` | required: keys vote hashes and claim tokens |
| `BUILTINDIE_ORIGIN` | public address (default https://built.indie.pit.world) |
| `BUILTINDIE_DATA` | where the database and pictures live (default ~/.local/share/built-indie) |
| `BUILTINDIE_ADMIN_KEY` | bearer that may take a listing down |
| `RESEND_API_KEY`, `MAIL_FROM` | sign-in mail; without them the link is logged |
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET` | Featured payments |
| `FEATURE_USD`, `FEATURE_DAYS` | price and length of Featured (19, 7) |
| `BUILTINDIE_CHROME` | Chrome path, or `off`; `BUILTINDIE_SCREENSHOTS=off` skips screenshots |
| `CRAWLPROOF_SITE`, `CRAWLPROOF_AD_SLOT` | analytics and ads; `off` turns either off |

Production runs on dev2 under `bin/install.sh` (OpenInstall); every merge to main deploys. See `OpenStack.md`.

MIT. Part of the [Moshpit ring](https://pit.world/ring).
