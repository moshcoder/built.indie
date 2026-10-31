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

**Free to launch, no account.** Anyone can launch any site. To edit a listing, sign in (an emailed link) and **claim** it. The easy way is the badge: put the wide or square built.indie badge on the homepage. The square version adds `&shape=square` to `/images.svg?id=<id>`. Its id is unique to that listing and your account (the claim page, `claim.md`, the API, CLI and MCP hand you the full snippets). Finding either badge claims the listing for you and earns the followed link and the ✓ in one step. Or add a DNS TXT record, `_built-indie.<domain>` → `built-indie-verify=<token>`. (Badges placed earlier as `/badge/<slug>.svg?claim=<token>` still claim.) A signed-in submitter can edit until the owner claims it.

Viral bits: a live badge with the upvote count (`/badge/<slug>.svg`) that turns a link back into a followed link and a ✓ once we see it on the homepage, share buttons, an OG card per product, RSS, and an optional paid **Featured** slot: CoinPay's hosted checkout, where the buyer picks any coin or PayPal.

The shared footer badge uses `/for.svg?site=<homepage>`; add `&shape=square` for the built.indie brand mark in a square. The same `shape=square` option works on product badges and the account-specific verification badge at `/images.svg?id=<id>`.

**Tags.** Every listing is tagged with what its homepage declares (opensite.json `tags`/`keywords`, `<meta name="keywords">`, `article:tag`, JSON-LD `keywords`, `applicationCategory` and `genre`, manifest `categories`). A site that declares none gets up to four topics read from its own name, tagline and description (`src/tags.ts`), and listings launched before that are backfilled on start. Owners edit them on the listing. Browse at `/tags` and `/t/<tag>`; `GET /api/v1/tags`, `GET /api/v1/products?tag=<tag>`, `builtindie tags [tag]`, MCP `list_tags` and `tagged`.

**Invite program.** Every account has an invite link, `/i/<code>` (on `/invite`, `/me`, `builtindie invite`, `GET /api/v1/invites`, MCP `my_invites`). When a new member who signed up through it gets their first listing live, the inviter earns a credit: a free **Featured** week (the same slot that costs $19 in crypto). Spend it on any listing you own from `/invite`, the listing's page, `builtindie credit <slug>`, `POST /api/v1/products/<slug>/credit` or MCP `feature_with_credit`. Once per new member, never yourself; the code rides in the magic link, so it counts when the mail opens in another browser; an admin takedown of the listing takes back an unspent credit. The inviter gets an email when a credit lands.

**Credit codes and invite codes (0.7.0).** A credit code (`CR-XXXX-XXXX-XXXX-XXXX`, [@profullstack/redeem-credits](https://www.npmjs.com/package/@profullstack/redeem-credits), unit `featured_days`) adds Featured days to a member's balance: "Have a code?" on `/me`, `POST /api/v1/redeem`, `builtindie redeem <code>`, MCP `redeem_code`. The days go on any live listing you own through the same `featured_until` a paid week extends (`/me`, the listing's Feature card, `POST /api/v1/products/<slug>/feature-days {"days":n}`, `builtindie feature-days <slug> <n>`, MCP `feature_with_days`). Every member also has **3 single-use invite codes** ([@profullstack/affiliates](https://www.npmjs.com/package/@profullstack/affiliates)) on `/invite#codes`, `POST /api/v1/invites`, `builtindie invite-code`, MCP `create_invite`: someone new who signs up through `/i/INV-…` gives both people **2 Featured days**, and the sign-up counts once in the invite program above (same `invites` row). `?ref=<your invite code>` on any page is your invite link too (the same `bi_ref` cookie, first touch). Mint codes on the server:

```sh
cd /opt/built.indie && /root/.bun/bin/bun $(readlink -f node_modules/.bin/redeem-credits) mint \
  --db /root/.local/share/built-indie/built-indie.db --unit featured_days --amount 7 --label "for Ada"
```

**Webhooks (0.8.0).** Makers get a webhook callback for their own listings, on [@profullstack/webhooks](https://github.com/profullstack/webhooks): `product.launched`, `product.claimed`, `product.verified`, `product.featured` (`data.via` = payment, invite_credit or featured_days), `product.upvoted`, `comment.created`, `review.created` (both only from someone other than the owner) and `invite.earned`. Each goes to the listing's owner (the account that claimed it, else the member who launched it); an anonymous launch has nobody to tell. Bodies are CloudEvents 1.0 (`data.product` = id, slug, name, url, page, votes, featured_until), signed per Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`), retried from a durable outbox (`webhook_*` tables in the same database) for about three days. Manage them on `/me#webhooks`, at `/api/v1/webhooks` with your `bi_` key (list, add, test, rotate, remove, delivery log), `builtindie webhooks` / `builtindie webhook add <url> [events…]`, or MCP `create_webhook`, `list_webhooks`, `test_webhook`, `rotate_webhook_secret`, `delete_webhook`, `webhook_deliveries`.

**Leaderboard.** `/leaderboard` ranks the top inviters (week, month, all time) with badges, on [@profullstack/leaderboard](https://github.com/profullstack/leaderboard). It projects the `invites` table, so there is no second ledger; badges live in the `lb_` tables of the same database. The package also serves `/leaderboard.json`, `/leaderboard/invites.json|.xml`, a share card per member at `/leaderboard/u/<id>`, and a widget any site can embed (`/leaderboard/embed.js`). Members appear by the name they set on `/invite`, else as "Maker of <their best listing>"; never by email.

**Browse and search.** A search box in the header of every page (press `/`; it suggests launches as you type) opens `/search`: a facet rail in the style of [r4ck.dev](https://r4ck.dev) with counts for category, tags, when it launched, what it has (✓ verified, claimed, video, llms.txt, OpenSite/OpenProfile/OpenStack/OpenSaaS), what it is built with (OpenStack.md) and maker, plus sort and active-filter chips. Values in one facet are OR'd, facets are AND'd, and each facet counts as if only it changed. Tags are what the page or the maker said; categories are a fixed set of twenty-one read from a listing's tags, name, tagline and description (`src/browse.ts`), so every launch is filed even with no tags. `/c/<category>` and `/t/<tag>` are indexable pages for one filter; the same query is `GET /api/v1/search` (products + facets), `GET /api/v1/categories`, `builtindie search … --category ai --has verified --facets`, and the MCP `search` / `list_categories` tools.

Every product is published back as an OpenSite record (`/p/<slug>/opensite.json`) and an OpenProfile (`/p/<slug>/openprofile.md`); makers are OpenProfiles too (`/makers/<id>/openprofile.md`). Icons are the [OpenIcon](https://github.com/profullstack/openicon) reference set.

## Surfaces

```sh
curl -fsSL https://built.indie.pit.world/install.sh | sh

builtindie                       # TUI: today's board, ←/→ boards, v upvote, l launch
builtindie launch yourproduct.com
builtindie top week
builtindie search crm --category ai --has verified   # filters, as on /search
builtindie show linear
builtindie vote linear
builtindie preview any.site --json
BUILTINDIE_KEY=bi_… builtindie claim linear   # prints your badge and the TXT record, then checks them
BUILTINDIE_KEY=bi_… builtindie edit linear --tagline "…"
BUILTINDIE_KEY=bi_… builtindie invite          # your invite link and free Featured credits
BUILTINDIE_KEY=bi_… builtindie credit linear   # spend one: Featured for a week
BUILTINDIE_KEY=bi_… builtindie redeem CR-…      # a credit code: Featured days
BUILTINDIE_KEY=bi_… builtindie invite-code     # one of your 3 single-use invites
BUILTINDIE_KEY=bi_… builtindie feature linear  # or pay: a CoinPay checkout link (any coin or PayPal)

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
| `COINPAY_API_KEY`, `COINPAY_BUSINESS_ID`, `COINPAY_WEBHOOK_SECRET` | Featured payments: a CoinPay hosted checkout session per purchase, settled by the signed webhook at `/hooks/coinpay` |
| `FEATURE_USD`, `FEATURE_DAYS` | price and length of Featured (19, 7) |
| `BUILTINDIE_CHROME` | Chrome path, or `off`; `BUILTINDIE_SCREENSHOTS=off` skips screenshots |
| `CRAWLPROOF_SITE`, `CRAWLPROOF_AD_SLOT` | analytics and ads; `off` turns either off |

Production runs on dev2 under `bin/install.sh` (OpenInstall); every merge to main deploys. See `OpenStack.md`.

MIT. Part of the [Moshpit ring](https://pit.world/ring).

## Karma (0.6.0)

Signed-in members earn karma for launching (+10), upvoting (+1, 20 a day), reviewing (+5, stars and 30+ characters), commenting (+2, 10 a day), sharing (+1, 5 a day), claiming (+5), a verified badge (+5) and an invited maker who launches (+25); listing owners get +1 per upvote and +2 per review from members. Acting on your own listing earns nothing; admin imports earn nothing. Every 500 karma (`KARMA_PER_CREDIT`) grants a free Featured week, spent like an invite credit. The ledger is append-only (`karma_events`, dedupe key per fact; reversals are negative rows). `/leaderboard` shows the karma board (default) and the inviters board; `GET /api/v1/karma`, `GET /api/v1/leaderboard?board=karma&period=week`; CLI `karma`, `leaderboard`, `comment`, `review`; MCP `my_karma`, `leaderboard`, `comment`, `review`. Same rules as pwamart.com.

## Sign in with CoinPay

Set `COINPAY_OAUTH_CLIENT_ID` and `COINPAY_OAUTH_CLIENT_SECRET` (an OAuth client at coinpayportal.com with redirect `<origin>/api/v1/coinpay/callback`) and /login and /me show "Sign in with CoinPay" (OIDC, code + PKCE S256). Accounts link by CoinPay `sub` in `user_identities`, never by email.
