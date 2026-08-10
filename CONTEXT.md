# Domain glossary — El Copero del Dota

The names below are the vocabulary of the codebase. Full mechanics live in
`docs/MULTIPLAYER.md`; this file just pins what each word means so code,
tests, and reviews all say the same thing.

## The game

- **Pack** — a real team at an event: 5 players + 5 signature heroes. Revealed
  whole; discarded once everyone has acted on it.
- **Spread** — the open packs on the table for one round: 1 pack for 2–4
  seats, 2 side-by-side for 5+. The opener may mulligan the whole spread.
- **Board** — one drafter's roster in progress: 5 role slots + 5 heroes.
- **Deny** — burn your pick to destroy any card in the spread (1 per game).
  A denied player is gone for everyone; a denied hero only leaves its pack.
- **Opener** — the seat that acts first on a spread; rotates each spread.
- **Field** — the 18 `SimTeam`s that enter the International (human + AI).
- **Sim** — the deterministic tournament: `simulateTournament(field, simSeed)`.
  Clients re-run it locally; the server only decides what is revealed when.
- **Beat** — one step of the broadcast reveal (`src/game/beats.ts`). Both the
  *schedule* (`buildBeats`) and its *meaning* (`revealAt(result, beats, idx) →
  RevealState`: what beat N puts on screen) are pure and shared by client and
  server; `Broadcast.tsx` only renders the `RevealState`. Taunt identity lives
  here too: `tauntOwner` (eligibility) and `seriesSeed`/`pickTaunt` (the one
  formula for phrase choice and scream-bubble shape).
- **Reveal / Broadcast** — the staged rendering of the sim, beat by beat.
- **Win phrases** — a drafter's victory taunts. Server-side secret; exactly
  one leaves the server, on its taunt beat.

## The Versus room

- **Room** — one lobby = one Durable Object (`CoperoRoom`), addressed by a
  5-char code. Phases: `lobby → drafting → assembled → broadcasting → done`.
- **Seat** — a drafter's place in the room; seat 0's holder is the host.
  Visitors without a seat are **spectators**.
- **Snapshot** — the full public room state broadcast to every connection on
  every change (`RoomSnapshot` in `src/mp/protocol.ts`). One type serves all
  seats; nothing per-seat is ever hidden in it.
- **Draft engine** — the pure reducer for *within-spread* rules
  (`src/mp/engine.ts`): turn order, legality, deny/mulligan semantics.
- **Room reducer** — the pure state machine for *everything else the room
  does* (`src/mp/room.ts`): seating and kicks, the spread cascade, timeouts
  and autopicks, assembly, the beat ticker, cleanup.
  `roomReducer(state, event, ctx) → { state, changed, effects… }`. It never
  touches a socket, a clock, or storage — those arrive through `ctx`.
- **Room host** — whatever executes the reducer's effects at the seam: the
  partyserver adapter (`worker/index.ts`) in production, the plain test
  harness in `src/mp/room.test.ts`. The host owns sockets, storage, the data
  bundle, the directory, and the one alarm slot; `nextAlarm(state)` tells it
  what that slot should hold.
- **Room view** — what a snapshot means to one player, and what should
  happen when the client's facts change (`src/mp/roomView.ts`).
  `deriveRoomView(snapshot, playerId, result?) → RoomView` answers the
  first (seat facts, the humans' final standings); **cues** answer the
  second — `roomCues` (stinger, win-phrase resync, run recording) and
  `draftCues` (the announcer's once-per-turn rule). All pure; the Room
  page renders the view and executes cues through its adapters (socket,
  announcer, localStorage, run history).
- **Draft seed** — `RoomState.draftSeed`: every spread's pack RNG derives
  from it, so a draft replays exactly from `(seed, actions)`.
- **Directory** — the public room listing. Policy is pure
  (`src/mp/directory.ts`); a listing that exists is safe to show anyone.
