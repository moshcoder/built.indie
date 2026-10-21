# built.indie

- **Kind**: product
- **Web**: https://built.indie.pit.world
- **Repo**: https://github.com/moshcoder/built.indie
- **Operator**: https://built.indie.pit.world/.well-known/openprofile.md
- **License**: MIT
- **Updated**: 2026-10-19

Launch your indie product with one URL: we read the homepage and the LogicSRC files it serves, keep the pictures, and put it on a daily upvote board.

## Languages

- TypeScript 5: everything, ES modules

## Runtimes

- Bun 1.4: the server, the CLI, the TUI and the MCP server
- Browser: the PWA (service worker, manifest)

## Interfaces

### Web

- Hono 4: server-rendered pages, no client framework
- public/app.js: votes, copy buttons, progress, service worker

### API

- Hono 4: JSON under /api/v1, OpenSite index calls under /api/v1/sites

### CLI

- @profullstack/builtindie: `builtindie`

### TUI

- @profullstack/hqtui: the board in a terminal

### MCP

- @modelcontextprotocol/sdk 1: stdio, zod 3 schemas

## Data

- SQLite (bun:sqlite): one file, WAL
- Files: pictures beside the database, checked by their first bytes

## Services

- CoinPay: hosted checkout sessions for Featured (any coin or PayPal)
- Resend: sign-in links
- crawlproof: analytics and ads
- Headless Chrome: homepage screenshots, run as nobody
- pit.world relay: the address everyone without Moshpit DNS uses

## Specs

- OpenSite 0.1: every product is a record; we are a reader and an index
- OpenProfile 0.4: products are organizations, makers are people
- OpenStack.md 0.1: read from products, served about ourselves
- OpenSaaS 0.1: plans and the cancel page, read from products
- OpenIcon 0.1: the reference set, a vendored subset

## Hosting

- dev2 (bare metal): systemd unit built-indie, nginx, OpenInstall bin/install.sh
- Moshpit name built.indie, certificate from the Moshpit registry

## Never

- No Stripe: payments are CoinPay
- No client-side framework, no bundler
- No secrets in .env files: app.env is written from the vault
