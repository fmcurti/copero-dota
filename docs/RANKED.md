# Ranked mode

Status: **implemented 2026-08-13.** Every decision below was made explicitly
with the project owner; the authentication side (identity, route layout, D1
ownership) is settled in `docs/AUTH.md` and not repeated here. Ranked requires
a Better Auth account; casual play stays untouched.

Where things live: rating math in `src/ranked/rating.ts`, shared constants and
the queue wire protocol in `src/ranked/protocol.ts`, every in-room ranked rule
in the room reducer (`src/mp/room.ts`, `RoomState.ranked`), the queue Durable
Object in `worker/rankedQueue.ts`, the authenticated room adapter and rating
write in `worker/rankedRoom.ts`, the read API in `worker/rankedApi.ts`, the
hub page in `src/pages/ranked/Ranked.tsx`, and the D1 tables in
`migrations/auth/0002_ranked.sql` (remember `npx wrangler d1 migrations apply
AUTH_DB --remote` before deploying).

## Shape of the feature

Ranked lives under **matchmaking only**. There is no ranked lobby creation:
players join a queue, the queue forms the room. Casual lobby creation is
unchanged and never rated.

- **Ranked hub page** — a dedicated page holding the queue, the leaderboard,
  and the signed-in player's match history. Signed-out visitors see the hub
  with a sign-in prompt.
- Ranked rooms are listed on the **watch tab as spectate-only** once the match
  starts (`visibility: "spectatable"`); they are never joinable from the
  directory. Room chat works as in casual.

## The queue

One global queue. Matchmaking does **no balancing** — the player base is too
small — it only gathers players.

- Membership is socket-based: presence requires an open connection to the
  queue; closing the page removes you. Deduped by Better Auth user ID, and a
  user seated in a live ranked match cannot queue.
- **Minimum 4, maximum 8** players per match (rooms support 8). Local dev
  (`npm run dev`) lowers the minimum to **2** so one person with two browser
  tabs can exercise the whole flow, and shortens the abandoned-match queue
  hold to **60s** (production: 3h); vitest and production builds keep the
  real values.
- At 4 players a **10-second fill countdown** starts. Late joiners fill toward
  a full room during it; joining does **not** reset or extend it. Members a
  full room could not take (position > 8) are shown no countdown.
- If a leaver drops the queue below 4 mid-countdown, the countdown cancels and
  the remaining players stay queued (front of the line). No sub-4 ranked room
  can ever form.
- **Ready check (2026-08-15, replacing "no accept step"):** when the fill
  countdown lands, the head of the queue — capped at 8 — is **locked into a
  Dota-style ready check** with a **15-second accept window** (longer than
  Dota's: a browser tab may be hidden). The roster is all-or-nothing:
  - Everyone accepts → the room is created and everyone is seated. The
    client holds the all-green grid for ~5s (the Dota reveal) before
    entering the room; accepting itself rolls the dialog over to the grid
    like a cube face. An AFK player from then on is carried by the normal
    timeout/autopick machinery.
  - **Decline = closing the socket** (the Decline button, the ✕, the tab).
    Any locked member leaving dissolves the check; nobody else is punished,
    and everyone still connected keeps their place at the front of the line.
    Survivors' next queue frame carries a one-shot **dissolved echo** — the
    dead check's grid with the failing slots marked — so the client can burn
    the decliner's square red for a beat (Dota's MATCH DECLINED moment)
    before returning to the finder.
  - The deadline passing **kicks whoever never accepted** out of the queue
    (no further penalty in v1); the accepted keep the front of the line and a
    fresh fill countdown arms at once if enough remain.
  - The client sends exactly one frame, `{"t":"accept"}`. Ready frames carry
    the roster anonymized to accept-state plus avatar (user.image, size-capped
    so 8 avatars stay under the DO's 1MiB websocket message limit).
- **No queue timeout.** Matchmaking floats over every page (the bottom-right
  finder, as in Dota) with a cancel ✕; nothing auto-redirects.
- `GET /api/ranked/queue-status` publicly exposes only the live count and the
  active deadline (fill or ready-check). Reading it does not create a queue
  connection.
- Per `docs/AUTH.md`: the queue (not a client flag) authorizes users and
  creates the ranked room.

## The ranked room

A separate authenticated PartyServer adapter (`/parties/ranked-room/:id`)
reusing the existing pure room reducer and draft engine. Connection identity is
`session.user.id`; one seat per account.

Fixed server-side config — `DEFAULT_MP_CONFIG` with two overrides:

```ts
{ ...DEFAULT_MP_CONFIG, cardMode: "event", visibility: "spectatable" }
// valve_legacy, event OVRs, auto hero alloc, classic draft, 15s timer, 1 mulligan
```

Config is immutable and there are no host powers (no kicks, no config edits) —
the room has no meaningful host.

Players still **pick a team name per game**, signed in or not. The team name
is in-room flavor (draft, broadcast, chat); everything durable — leaderboard,
profile, history — shows the Better Auth account name (the nickname). The
leaderboard also says who is behind each nickname: the Google account name
(`user.accountName`, synced from the ID token on every Google sign-in) or, for
password accounts, the part of the email before the `@` — never the full
address, since the hub is public.

## Rating system

**Pairwise Elo over the humans' relative finishing order.** AI teams and
absolute tournament placement do not enter the exchange, with one exception:
winning the whole International grants a flat bonus.

For each pair of humans (i, j) in the match:

```text
E_ij = 1 / (1 + 10^((R_j − R_i) / 400))
S_ij = 1 if i finished above j, 0 if below, 0.5 on a tie
Δ_i  = (K / (n − 1)) · Σ_j (S_ij − E_ij)
```

- Finishing order is the humans' relative order in the final standings
  (shared placements are already broken by games won; a residual tie scores
  0.5).
- Zero-sum across the room when everyone shares a K. New-player K makes it
  slightly non-zero-sum; accepted deviation.
- **TI-champion bonus**: a human who wins the International gets a flat bonus
  on top of the exchange (the one deliberately non-zero-sum element).
- Rating floors at 0 (clamped after the delta; the clamp's zero-sum breakage
  at the bottom is accepted).

Initial tunables — all in one constants module, recorded as starting values,
not commitments:

| Constant | Value |
| --- | --- |
| Starting rating | 1000 |
| Elo divisor | 400 |
| K, first 10 ranked games | 64 |
| K afterwards | 32 |
| TI-champion bonus | +15 |
| Floor | 0 |

Rating is calibrated by the higher early K only — no placement games, no
hidden rating; the number is visible from game one.

## Abandons and penalties

- A disconnected or AFK player is autopicked through; the match **always plays
  to completion and always rates everyone**, leaver included. No voiding, no
  special leaver loss — an autopicked board tends to place low on its own.
- **No penalty system in v1** (no cooldowns, no low priority). The schema
  keeps a seat open for a future penalties table per `docs/AUTH.md`.

## Data (D1, keyed by Better Auth user ID)

The ranked module owns its tables, separate from Better Auth's. The ladder is
eternal — no resets — but every table carries a `season` column now so a
future season rollover is a data change, not a schema redesign.

- `ranked_profiles` — user, current rating, games played, season.
- `ranked_matches` — match id, season, room code, config snapshot, sim seed,
  timestamps.
- `ranked_match_players` — match, user, seat, team name, human-relative
  placement, tournament placement, rating before/delta/after.

The server-authoritative ranked module computes ratings and writes the result
once, idempotently, after the server-side match completes. Ratings are never
computed client-side.

## Presentation

- **Raw MMR number** shown everywhere relevant (hub, queue, room, profile).
  No medals or tiers.
- **Public leaderboard** on the hub in v1.
- **Profile/history page**: each ranked game with date, placement, ±MMR;
  rating graph can come later. Full match-detail pages (stored boards) are out
  of scope for v1.
