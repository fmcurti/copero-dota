# Multiplayer Implementation Plan

Status: **implemented 2026-08-07** (all phases; deploy pending account choice).
Verified by: 16 vitest engine tests incl. real-pool fuzz (`npx vitest run`),
scripted 2-bot WebSocket e2e (full draft with deny/mulligan/reconnect/host
gating/beat pause-resume-skip), a 30s DO-alarm autopick test, a solo-semantics
regression script, and a live browser session (lobby → draft → broadcast → done).
This turns the mechanics locked in
[MULTIPLAYER.md](./MULTIPLAYER.md) into a file-by-file build plan. Infra
details verified 2026-08-07 against current `partyserver` / `partysocket` /
`@cloudflare/vite-plugin` docs and Cloudflare's official `playground/partyserver`
fixture (which is almost exactly this architecture).

Guiding constraints:
- **Solo mode keeps working untouched** — every refactor is backwards compatible.
- **One repo, one Worker, one deploy** on our own Cloudflare account (free tier,
  SQLite-backed Durable Objects).
- **Server-authoritative**: the DO owns the room state machine; clients render snapshots.
- **Determinism**: clients recompute the sim locally from `(field, simSeed)`; the
  server only decides *what is revealed when*.

## Architecture at a glance

```
Browser A ──┐                        ┌─ env.ASSETS (dist/: SPA + /data/*.json)
Browser B ──┼─ WebSocket /parties/… ─┤
Browser C ──┘                        └─ CoperoRoom (Durable Object, partyserver)
                                          │ imports src/game/* (pure, deterministic)
                                          │ imports src/mp/engine.ts (pure draft reducer)
                                          │ ctx.storage: room snapshot (reconnect/hibernation)
                                          │ DO alarm: turn timer + broadcast beat ticker
```

New layout:

```
src/game/        existing pure modules (small backwards-compatible refactors)
src/mp/          NEW — shared by client & server: protocol.ts, engine.ts, autopick.ts, synergy.ts
worker/index.ts  NEW — worker entry: CoperoRoom DO + asset fallthrough (own tsconfig.worker.json)
src/pages/mp/    NEW — Lobby/Room client pages
```

`src/mp/` and `src/game/` stay React-free and I/O-free (the DO imports them).

---

## Phase 0 — Backwards-compatible refactors to existing code

Solo behavior must be pixel-identical after this phase.

1. **`src/game/types.ts`** — add `ownerId: string | null` to `SimTeam` (null = AI;
   solo uses `"solo"` and keeps `isUser`). Add `SimResult.ownerStats:
   Record<ownerId, { place, label, undefeated, flawlessGroup, gamesWon, gamesLost }>`.
2. **`src/game/sim.ts`** — replace the single user-tally block with a loop over all
   owned teams filling `ownerStats`; keep the existing `user*` fields derived from it.
3. **`src/game/field.ts`** — new `generateFieldMulti(humans[], fieldSeed)`:
   `18 − N` AI teams, mean = `avg(human strength) + 1`, sd 5, clamp [76, 99].
   Existing `generateField` becomes a wrapper with AI mean pinned at 86 (solo unchanged).
4. **New `src/game/beats.ts`** — move `Beat`, `ROUND_SCHEDULE`, `buildBeats` out of
   `Broadcast.tsx` (server needs them, React-free). Generalize: game ticks for any
   match with an owned team; group order = fewer-humans group first (solo semantics kept).
5. **`src/components/Broadcast.tsx`** — new optional props:
   `controlled?: { idx, playing }` (disables the internal timer; server drives),
   `onControl?: (pause|resume|skip) => void` (host-only buttons),
   `perspectiveOwnerId?: string` (whose ●○ dots). Human-team highlighting keys off
   `ownerId != null`; your team keeps the strong treatment. Human-vs-human dots render
   from the perspective team if present, else relative to team A. Solo call site unchanged.
6. **`src/game/data.ts`** — `loadBundle(fetchJson?)` with the current browser fetch
   as default; the DO injects an `env.ASSETS.fetch`-backed fetcher.

Gate: `npm run build` + full solo run in the browser, nothing changed.

---

## Phase 1 — Shared multiplayer modules (`src/mp/`)

### `protocol.ts` — wire contract
Everything in this game is public, so one snapshot type serves all seats.

```ts
type Phase = "lobby" | "drafting" | "assembled" | "broadcasting" | "done";
interface MpConfig { format; cardMode; timerSecs: 30|45|90|null; mulligans: 0|1|2 }
interface Seat { playerId; name; connected; isHost }   // seat 0 = host, fixed for v1
type CardRef = { kind: "player"; steamId } | { kind: "hero"; heroId };

interface DraftPublic {
  packSeq; openerSeat; turnSeat: number | null; turnDeadline: number | null; // epoch ms
  currentPack: DrawnPack | null;       // taken cards already removed
  boards: { slots: Slots; heroes: number[] }[];
  takenSteamIds: number[];
  deniedShelf: { card; bySeat; packSeq }[];
  mulligansLeft: number[]; deniesLeft: number[];
}

interface RoomSnapshot {
  phase; config; seats;
  draft: DraftPublic | null;
  strengths: TeamStrength[] | null;    // assembled →
  field: SimTeam[] | null; simSeed: number | null;
  beat: { idx: number; playing: boolean } | null;  // broadcasting →
}

// client → server: hello {playerId,name} · configure · start · pick {card} ·
//                  deny {card} · pass · mulligan · play · beat {pause|resume|skip}
// server → client: snapshot {room} · error {code,msg} (seat-targeted)
```

### `engine.ts` — pure draft reducer (fully unit-testable)
No I/O, no timers — the DO owns *when*, the engine owns *what*.

```ts
createDraft(numSeats, config): EngineState
openPack(state, pool, rng): EngineState          // sets currentPack + turnSeat
applyAction(state, seat, action): { state; error? }   // pick | deny | pass | mulligan
legalActions(state, seat): { picks; canDeny; canPass; canMulligan }
isDraftDone(state): boolean
```

Rules encoded (ambiguities in MULTIPLAYER.md resolved here):
- **Turn order per pack**: opener first, wrap around, skipping complete boards.
  Opener rotates to the next incomplete seat after each pack.
- **Pick legality** = solo `canPickPlayer`/`canPickHero` vs your own board + global
  `takenSteamIds`.
- **No legal pick**: you get the turn only if you can still Deny (Deny or Pass);
  otherwise the server auto-passes you — no dead turns.
- **Deny**: any card left in the pack, consumes your action. A denied **player** is
  globally destroyed (into `takenSteamIds`); a denied **hero** only leaves this pack
  (heroes are shared — the card is destroyed, not the hero). Both hit the shelf.
- **Mulligan**: opener only, before anyone acts on the pack; replacement pack, same opener.
- **Pack draw**: pool minus `usedPackIds`; prefer packs with a card pickable by the
  **opener**, fallback any incomplete seat, fallback any unused pack. Reuses the
  solo soft-lock-proof machinery (export `packPickable`/`materialize` + hero-swap
  guard from `src/game/draft.ts` as a parameterized `drawPackFrom`).
- Done when every board is 5+5.

### `autopick.ts`
Deterministic timeout fallback: best legal player by `ovr + heroFitBonus(best games
on a board hero)`; else best legal hero by total games across the seat's roster.
Never denies, never mulligans.

### `synergy.ts`
`synergyHints(steamId, myBoard, allBoards, taken, squadSynergy)` → the
"412g with YOUR LaNm (+1.8)" / "800g with Ana — still undrafted" badges
(compact badge + tooltip). Exports reuse the pair-bonus math from `strength.ts`.

---

## Phase 2 — The server

### `CoperoRoom extends Server<Env>` (partyserver)
- Room id = URL code (5 chars, alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ`, client-generated).
- `static options = { hibernate: true }` — hibernation wipes memory, so **rehydrate
  from `ctx.storage` in `onStart()`** and persist after every accepted action.
  Socket→seat via `connection.setState({playerId})` (survives hibernation).
- `hello`: known playerId → reattach (`connected = true`); new + lobby + <4 seats →
  new seat; new mid-game → reject (spectators are later polish). Close → `connected = false`.
- `start` (host, ≥2 seats): load bundle via ASSETS, build card pool once,
  `createDraft` + `openPack`, set turn alarm, → `drafting`.
- Draft actions: validate `turnSeat`, run `applyAction`, advance/open next pack,
  reset alarm, broadcast snapshot. Errors only to the offending socket.
- **Turn timer**: one DO alarm (`ctx.storage.setAlarm` + `onAlarm()` — never raw
  `alarm()`, partyserver owns it). On fire, if the same turn is live → autopick.
  Turn timer / beat ticker / cleanup never coexist, so the one-alarm-per-DO limit
  is fine. `onAlarm` must be idempotent (at-least-once + retries).
- Draft done → `assembled`: seed each seat with the optimal hero assignment,
  `computeStrength`, `generateFieldMulti`, and roll `fieldSeed`/`simSeed`. In
  manual mode, each drafter can swap heroes on their own board; the server
  validates the swap and recomputes strengths/field. No field rerolls.
- `play` (host) → `broadcasting`: server runs `simulateTournament` once (only for
  the schedule), `buildBeats`, advances `beat.idx` on an alarm chain per beat's `ms`;
  `beat` actions pause/resume/skip. Last beat → `done`.
- Cleanup: `done` + all disconnected → `ctx.storage.deleteAll()` on a +1h alarm.

Clients never receive `SimResult` — they recompute `simulateTournament(field, simSeed)`
locally (deterministic) and render `Broadcast controlled={beat}`.

### Infra wiring (verified)
- Packages: `partyserver@0.5.x`, `partysocket@1.3.x`, dev `@cloudflare/vite-plugin@1.51.x`.
  No `nodejs_compat`.
- `worker/index.ts` default export:
  `(await routePartykitRequest(request, env)) ?? env.ASSETS.fetch(request)`.
- `wrangler.jsonc`: `main: "./worker/index.ts"`;
  `durable_objects.bindings: [{ name: "CoperoRoom", class_name: "CoperoRoom" }]`
  (**binding name must equal class name**);
  `migrations: [{ tag: "v1", new_sqlite_classes: ["CoperoRoom"] }]`
  (**`new_sqlite_classes` — required on free tier**);
  assets gains `binding: "ASSETS"` + `run_worker_first: ["/parties/*"]`;
  drop `assets.directory` once the vite plugin manages the build.
- Client: `usePartySocket({ party: "copero-room", room: code })` — `party` is the
  **kebab-cased binding name**; host omitted = same origin. Auto-reconnect with
  backoff, buffers sends while down.
- Dev loop: add `cloudflare()` to `vite.config.ts` → single `vite dev` runs the SPA
  with HMR **and** the DO in workerd, WebSockets included. Deploy stays
  `npm run build && wrangler deploy`.
- Gotcha: `env.ASSETS.fetch` applies SPA not-found handling — a typo'd
  `/data/x.json` returns `index.html` with 200. Guard on response content-type.
- Free tier: 100k DO req/day, 13k GB-s/day, WS messages billed 20:1 (hibernation
  makes idle lobbies ~free), 5 GB SQLite.

---

## Phase 3 — Client

- `src/mp/client.ts`: `getPlayerId()` (localStorage uuid) + `usePartySocket` wrapper
  exposing `{ snapshot, connected, send }`. Snapshot in plain React state — the solo
  zustand store is untouched.
- Routes (HashRouter): `/mp` (create lobby → generates code / join by code; team
  name defaults from the solo store) and `/mp/:code`, rendering by phase:
  - **lobby**: seat plates, big room code, host config panel (extract `OptionCard`/
    `Section` from `Home.tsx` into `src/components/options.tsx`), Start (≥2 seats).
  - **drafting**: current pack center (reuse `CardButton`/card contents + synergy
    badge), Deny toggle (arms deny-mode), Pass/Mulligan when legal, turn banner with
    countdown from `turnDeadline`; right rail = all boards (`MiniBoard` compact
    variant of `RosterBoard`) + denied shelf.
  - **assembled**: all boards + strength tiles, field list, host-only Play.
  - **broadcasting/done**: `Broadcast controlled={beat}` with
    `perspectiveOwnerId = myPlayerId`, `onControl` for host; done-footer = lobby
    winner plate + per-human standings + Rematch (fresh code).
- Nav gains a "Versus" link. Optional: on `done`, record your own `RunRecord`
  locally with a "vs N humans" marker.

---

## Phase 4 — Testing & verification

1. **Engine unit tests** — add `vitest` (dev dep). Cover: turn/opener rotation,
   skip-complete-boards, deny/pass gating, deny player-vs-hero semantics, mulligan
   window, pack-draw fallbacks, scripted 4-seat draft to completion, autopick
   determinism, and a seeded fuzz loop (500 drafts × 2/3/4 seats × 3 card modes →
   always terminates, boards always legal).
2. **Solo regression** after Phase 0 and at the end.
3. **Local MP smoke**: `vite dev`, two windows — full 2-seat draft with a deny, a
   mulligan, and a timer expiry; lockstep reveal; host pause affects both.
4. **Reconnect**: kill a tab mid-draft, rejoin by URL; timer autopicks meanwhile.
5. **Deploy**: `npm run deploy` (one-time `wrangler login`), real 2-device session.

## Build order

| Step | Deliverable | Gate |
|---|---|---|
| 0 | Refactors, solo identical | solo regression |
| 1 | `src/mp/` engine + protocol + vitest green | unit tests |
| 2 | DO room: lobby/join/config/snapshot | two tabs see each other |
| 3 | Draft loop server+client (timer, deny, mulligan) | full 2-seat draft locally |
| 4 | Assembly + synchronized broadcast | lockstep reveal in two tabs |
| 5 | Reconnect + polish (countdown, shelf styling, rematch) | reconnect test |
| 6 | Deploy | real session |

## Decisions made here (were open questions in MULTIPLAYER.md)
- Synergy intel: compact badge + tooltip with full numbers.
- Host pause during broadcast: yes (host-only).
- Autopick: OVR + current-hero fit for players, roster-fit games for heroes;
  never spends Deny/mulligan.
- No-legal-pick seats get the turn only if they can still Deny; else auto-passed.
- Denied player = globally destroyed; denied hero = removed from that pack only.
- Room codes: 5-char unambiguous alphabet, client-generated.
- Host fixed at seat 0; host migration, spectators, sounds, ladder → post-v1.
