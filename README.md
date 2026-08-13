# El Copero del Dota

A fan-made clone of [322-0.app](https://322-0.app)'s **Classic** mode — a Dota 2
drafting roguelite: open packs (a real team at a real TI/Major), draft 5 pros +
5 heroes one card at a time, then simulate a full 18-team International
(groups + double-elim bracket) against a generated field. Chase the flawless
**322–0** run.

On top of the original, player cards support three modes:
- **Career Average** (default) — one card per pro, stats averaged over every
  event they attended, weighted by games.
- **Peak Form** — one card per pro, best event blended 1-2-1 with the events
  right before/after it.
- **Per Event** — the original: a different card for each event a pro attended.

Planned next: multiplayer lobbies (snake draft with shared packs, head-to-head
sim) via PartyKit on Cloudflare — see `docs/MULTIPLAYER.md`. Reverse-engineering
notes for the original game live in `docs/FINDINGS.md`.

## Develop

```sh
npm install
npm run dev
```

## Deploy (Cloudflare Workers static assets)

```sh
npm run deploy   # = vite build + wrangler deploy (needs `wrangler login` once)
```

Stats from [Datdota](https://datdota.com). Not affiliated with Valve. Team and
player names are informational and remain the property of their owners.

## Optional accounts

Better Auth provides optional Google and email-code sign-in for future ranked
features; casual play does not require an account. See [docs/AUTH.md](docs/AUTH.md)
for the design and production setup. For local auth work, copy
`.dev.vars.example` to `.dev.vars`, fill the provider values, and apply the
local D1 migration:

```sh
npx wrangler d1 migrations apply AUTH_DB --local
```
