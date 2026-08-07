# 322-0.app — Reverse-Engineering Findings

Everything below was decoded from the production bundle of https://322-0.app
(`assets/index-BCFh8CR5.js`, fetched 2026-08-07). The app is a fully client-side
Vite/React SPA — **no backend, no API**. All game data is static JSON under
`/data/`, all randomness is client-side. This is great news for us: the whole
game is a set of pure functions over static data, which is exactly what a
server-authoritative multiplayer version needs.

## Data files (copied into `public/data/`)

| File | Size | Shape |
|---|---|---|
| `events.json` | 6 KB | 44 events: `{id, name, short, type: "ti"\|"major", year, patch, formats: ["valve_legacy"?, "standard"?]}` |
| `packs.json` | 557 KB | 703 packs = **a team at an event**: `{id, eventId, teamId, teamName, tag, logoId, placement, players[5], signatureHeroes[]}`. Player: `{steamId, nickname, role, ovr, impact, economy, reliability, games}`; role ∈ safelane/mid/offlane/support |
| `heroes.json` | 6 KB | 127 heroes `{id, name, picture}` |
| `playerHeroStats.json` | 1.1 MB | `steamId → heroId → {games, winrate}` (career, tier 1–2) |
| `squadSynergy.json` | 221 KB | 3865 groups `{ids: number[2..5], games, winrate}` — games played together |
| `teammates.json` | 60 KB | `steamId → steamId[]` (who played with whom; only used for encyclopedia UI) |
| `eventHeroStats.json` | 960 KB | per-event hero stats (encyclopedia/browse UI only, not used by the sim) |

Hero images: `https://cdn.datdota.com/images/heroes/{picture}_full.png` (hotlinked).

## Draft (Classic mode)

- Config: format (`valve_legacy` / `standard`), difficulty = rerolls (Hard 0 /
  Easy 1 / Smurfing 2), scoring (`event` only; `peak` marked SOON), hero
  allocation (`auto` / `manual`).
- Pool = packs whose event includes the chosen format.
- A **draw** picks a uniformly random pack from the pool and shows its 5
  players + `shuffle(signatureHeroes).slice(0,5)`. Retries up to **80 times**
  until the pack has ≥1 pickable card.
- You pick exactly **one card** per pack (player or hero), then a new pack is
  drawn. Complete at 5 players + 5 heroes.
- Roster slots: `safelane, mid, offlane, support1, support2`. A support fills
  support1 first, then support2. A steamId already on the roster can't be
  offered/picked again (relevant per-event: the same pro exists at many events).
- Reroll = skip current pack, draw again (decrements rerollsLeft).
- Run state is persisted in localStorage (zustand persist), history capped at 50.

## Team strength

```
overall = round( avgOVR + heroBonus + chemBonus )

heroBonus = round( Σ_players heroFit × 1.5 , 1 decimal)
  heroFit  = games_on_assigned_hero > 0 ? min(1, games/25) : 0
  → max +7.5

chemBonus = min(13, Σ_groups sizeMult(n) × min(4, games_together/230))   (1 decimal)
  sizeMult = {2: 1, 3: 1.6, 4: 2.2, 5: 3}
  groups   = squadSynergy entries whose ids are ALL on the roster
  → max +13
```

Auto hero assignment: over all 120 permutations of the 5 drafted heroes onto
the 5 players, maximize total games-on-hero (from playerHeroStats). Manual mode
lets the user swap assignments; games/fit recompute accordingly.

## Field generation

- 17 AI opponents + user = 18 teams.
- AI strength = `round(clamp(gaussian(mean 86, sd 5), 76, 99))`.
- Names: 4–8 "special" joke names + `{prefix} {suffix}` combos, all seeded from
  `fieldSeed`. Rerolling the field = new random `fieldSeed`.
- Seed-rank display: user's rank in the field ±1.

## Tournament simulation (seeded, fully deterministic)

- PRNG: mulberry32-family; sim seeded with `simSeed ^ 0x9E3779B9`.
- Per-game win probability (Elo-like, **divisor 22**):
  `P(A beats B) = 1 / (1 + 10^(-(strA - strB)/22))`
- **Groups**: sort 18 teams by strength desc; snake seed `i%4 ∈ {0,3} → A`,
  else B (9 each). Full round-robin via circle method, **Bo2** (2 independent
  games). Standings: wins desc, then strength desc, then id. 9th of each group
  → 17th/18th.
- **Playoff bracket** (all Bo3, GF Bo5); group positions u=A, d=B:
  - UB R1: u1–d4, d1–u4, u2–d3, d2–u3
  - UB SF: winners pairwise; UB Final.
  - LB R1: u5–d8, d5–u8, u6–d7, d6–u7 → losers 13–16th
  - LB R2: LBR1 winners vs UB R1 losers in reverse order (W0 vs L3, W1 vs L2,
    W2 vs L1, W3 vs L0) → losers 9–12th
  - LB R3: winners pairwise → losers 7–8th
  - LB R4: vs UB SF losers crossed (W0 vs SFL1, W1 vs SFL0) → losers 5–6th
  - LB R5 → loser 4th; LB Final (vs UB Final loser) → loser 3rd
  - Grand Final Bo5 → 2nd/1st
- Series = independent games at fixed P until one side reaches ceil(bestOf/2).
- Tracked: user games won/lost, `userUndefeated` (champion with 0 game losses —
  the eponymous "322-0"), `flawlessGroup` (0 group-stage game losses).

## Our deviations from the original

- **Player card modes** (config `cardMode`), replacing/augmenting the
  one-card-per-event default:
  - `career`: one card per pro; ovr/imp/eco/rel averaged over all their event
    instances **weighted by games at each event**; role = most-played role;
    nickname/team = most recent event's.
  - `peak`: one card per pro; best-OVR event blended with the chronologically
    adjacent attended events, weights **1-2-1**; role/nickname from the peak event.
  - `event`: the original behaviour.
  Packs keep their team@event identity and signature heroes in all modes; only
  the player stat lines are substituted.
- **Draw is soft-lock-proof.** The original samples up to 80 random packs and
  then shows an unpickable pack anyway — with role-consolidated card modes this
  can strand a draft (e.g. only mid open, heroes full; 13% of career-mode packs
  have no mid). We filter the pool to packs with ≥1 pickable card and draw
  uniformly from that subset (and ensure a pickable hero is among the 5 shown
  when a pack qualifies only via heroes).
- AI team names / reroll-excuse strings are our own lists (same spirit).
- The original's "Esports Manager" career mode is intentionally out of scope.

## Cloned app architecture (this repo)

- `src/game/*` — **pure, framework-free, deterministic** modules: `rng`,
  `cards` (card modes + pool building), `draft` (rules), `strength`, `field`,
  `sim`. No DOM, no React, no `Date`/`Math.random` inside the seeded paths
  (draw uses an injected RNG). These can be imported unchanged by a PartyKit
  server.
- `src/game/store.ts` — zustand + persist; the only stateful piece.
- `src/pages`, `src/components` — React UI.
- Deploy: static build via `wrangler deploy` (Cloudflare Workers assets).
