# Multiplayer Design — "El Copero del Dota"

Status: **implemented 2026-08-07** — see [IMPLEMENTATION.md](./IMPLEMENTATION.md)
for the build record. All mechanics below were decided 2026-08-07. Hosting:
everything on Cloudflare in ONE Worker — static client + **partyserver**
realtime rooms (Cloudflare's PartyKit successor on Durable Objects; one room =
one lobby = one DO, class `CoperoRoom` in `worker/index.ts`).

## The pitch

2–4 friends join a lobby, draft all-time rosters from shared packs, and their
teams land in the same 18-team International (AI teams fill the rest). One
dramatic sim decides the Copero.

## Decisions

### Lobby
- **2–8 human drafters**. With 5+ seats each round opens a **double spread**:
  two team packs side by side as one shared 20-card table (no shared players
  between them, displayed heroes deduped) — everyone still takes exactly one
  card per round, so late pickers keep real choices. A mulligan burns the
  whole spread.
- Host configures: format (valve_legacy/standard), **card mode (career
  default** / peak / event), hero allocation (**automatic** default / manual),
  **draft mode (classic default / turbo)**, turn timer (**7/15/25/off**,
  default 15 — retuned from 30/45/90 after playtesting: drafts dragged),
  mulligans per drafter (default 1, range 0–2 as the difficulty knob).
- Join by room code. Reconnect = replay current snapshot from the DO.
- Visitors are auto-seated while the lobby has room. A seated drafter can sit
  out before the draft starts (and reclaim an open seat); visitors to a full,
  in-progress, or finished room join as read-only spectators. Spectators see
  the same live draft, broadcast, and final results snapshot as the drafters.

### Draft — booster pass-around with team packs
- Packs are the original kind: **a real team at an event** — 5 players + 5
  signature heroes (card mode applied to the stat lines).
- A pack is revealed to everyone. The **opener** picks 1 card, then the pack
  passes around the table and **each drafter takes exactly one card** from the
  leftovers. Once everyone has picked once from it, the pack is **discarded**
  (it does NOT run until empty).
- **Opener rotates** each pack (A→B→C, then B→C→A, …) so first-pick windfalls
  (an OG-at-TI8 pack is a jackpot) even out over the draft.
- **Pick legality = solo rules**: the card must fit your board (open role
  slot, undrafted-by-you hero, <5 heroes). If nothing in the pack fits you,
  you're **skipped** for that pack (no penalty — the draft runs until every
  board has 5+5). Drafters with complete boards are skipped entirely.
- **Players are exclusive** across the lobby (a pro drafted by anyone is gone
  for everyone). **Heroes are shared** (two teams can both play Pudge).
- **The Deny**: each drafter has **1 per game**. Instead of a normal pick you
  may take ANY card in the pack — including one that doesn't fit your board —
  and destroy it. It consumes your pick for that pack and lands on a public
  **denied shelf with your name on it**, visible for the rest of the session.
- **Opener mulligan**: when it's your turn to open a pack, you may burn your
  mulligan to discard it before anyone picks; a replacement pack is revealed
  (everyone drafts from the replacement). Personal resource, group consequence.
- **Chemistry intel is fully visible**: every player card in a pack shows its
  synergy hooks — "412g with YOUR LaNm (+1.8)", "has 800g with Ana — still
  undrafted". Chemistry numbers unchanged from solo (+13 cap etc.). Sniping a
  friend's stack with a card you can legally use is intended gameplay; the
  Deny is the nuclear option.
- **Timer** (if on): timeout → autopick = best legal card by OVR + hero-fit
  delta. AFK friends get a mediocre board, not a dead one.
- Pack drawing uses the soft-lock-proof filtered draw (see FINDINGS.md),
  evaluated against the union of all boards' needs so every revealed pack is
  pickable by at least the opener.

### Turbo mode — the booster chain (added 2026-08-11)

Everything above describes **classic** mode. **Turbo** keeps the same cards,
legality, exclusivity, Deny and chemistry rules, but removes the shared turn:

- Each round deals a **wave**: one pack per incomplete seat, dealt to that
  seat (player-disjoint across the wave; same filtered draw, preferring packs
  the dealt seat can pick from). Everyone picks **simultaneously**.
- Acting on a pack (pick or Deny) passes its leftovers to the next seat in
  the chain. Packs queue at a busy seat in arrival order; you always act on
  the pack that reached you first.
- **Skip rule** (the "nothing fits" case): a pack an arriving seat cannot
  pick from — board complete, roles already filled, all five heroes drafted —
  passes through by itself, instantly and without penalty. There is no manual
  Pass in turbo; an unpickable pack never waits in your hands, so the chain
  cannot stall on a finished board.
- A pack every seat has acted on (or been skipped past) is **discarded**;
  when the whole wave is discarded and boards are still incomplete, the next
  wave is dealt. The draft ends the moment every board holds 5+5 (in-flight
  packs are dropped).
- **Deny** works only on the pack in your hands (it replaces your pick).
  **Mulligan** burns your own freshly dealt pack — before anyone has acted on
  it — and a replacement is dealt back to you; the rest of the wave is
  untouched.
- **Timer**: per-seat clocks. Your clock arms when a pack reaches your empty
  hands and re-arms per pack; timeout autopicks only your pack. The DO's one
  alarm slot holds the earliest armed clock.

### Tournament
- Field = N human teams + (18−N) AI teams.
- **AI strength scales to the lobby**: mean = min(avg(human team OVR) − 4,
  88), sd 5, clamped [76, 99]. The 88 ceiling is solo's fixed 86 mean +2, so
  exceptional drafts do not also make every bot exceptional. At −4, simulated
  bracket head-to-heads double while bots still win ~85% of Coperos. The
  contest is human-vs-human; bots are credible spoilers.
- **Natural seeding** exactly like solo (snake by strength into two groups of
  9) — humans land wherever their draft puts them.
- Hero assignment starts from the optimal automatic match. In manual mode,
  each drafter can swap the five heroes among their own players before the
  host presses Play; team strength and the shared field update for everyone.
  There are **no field rerolls**.
- **One dramatic sim** decides the session. Winner = best-placed human team.
- **Broadcast reveal**: results auto-advance in beats, simultaneously for
  everyone: group tables (the drafters' groups last) → bracket rounds on a
  real bracket layout (TBD boxes fill in; bot matches land whole; any HUMAN
  team's series ticks game by game). Already built for solo in
  `src/components/Broadcast.tsx` — multiplayer drives the same renderer from
  a server-synchronized beat index instead of a local timer.

### After
- **Sessions are standalone** — no persistent ladder for v1 (revisit later;
  DO storage makes an all-time tally cheap if we want it).
- Finished rooms keep their existing lifecycle: the Durable Object is deleted
  one hour after the room becomes empty. Spectating does not extend storage or
  add a results database; it only exposes the state while the room still lives.
- Rematch = host starts a fresh lobby (room codes are cheap).

## Why the current clone is ready for this

Everything in `src/game/` is pure and deterministic with injected RNG:
`drawPack`, `computeStrength`, `generateField`, `simulateTournament(field,
seed)`. The PartyKit server imports these modules unchanged, holds the room
state machine, and broadcasts snapshots; clients render the same data the solo
game already renders. `SimTeam.isUser` generalizes to `ownerId: string | null`
so results screens can highlight every human team.

## Room state machine

```
lobby → drafting → assembled → broadcasting → done
```

Server-authoritative. Client→server: `configure` (host), `spectate`, `takeSeat`,
`start` (host), `pick {cardId}`, `deny {cardId}`, `mulligan`, `assignHero`,
`play` (host), `beat` (host).
Server→clients: full room snapshot on every change (state is tiny) —
`{phase, config, seats[], openerIndex, currentPack, turnSeat, boards[],
takenSteamIds, deniedShelf[], mulligansLeft[], deniesLeft[], field?, simSeed?,
revealStage?}`. Timer runs server-side (DO alarm) → autopick on expiry.

## Build order (when we start)

1. Extract nothing — PartyKit project imports `src/game/*` directly
   (workspace or path import).
2. Room server: lobby + join/config + snapshot broadcast.
3. Draft engine: pass-around turn loop, legality, skip, Deny, mulligan, timer
   + autopick.
4. Client: lobby screen, shared draft screen (pack + all boards + synergy
   intel + denied shelf), reusing existing card components.
5. Assembly + broadcast reveal (staged rendering of the existing Results
   component).
6. Polish: reconnect, spectators, sounds/taunts.

## Open questions (minor, decide during build)

- Synergy-intel density on cards: full numbers vs a compact badge with tooltip.
- Does the host get a pause button during broadcast reveal? (lean yes)
- Autopick heuristic weighting fit vs raw OVR (lean OVR + fitBonus, ignore
  future chemistry).
- Show "X is thinking…" typing-style indicator on the active seat. (lean yes)
