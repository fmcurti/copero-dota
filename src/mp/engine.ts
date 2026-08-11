import {
  SLOT_IDS,
  canPickHero,
  canPickPlayer,
  emptySlots,
  isComplete,
  materialize,
  packPickable,
  slotForRole,
  type DrawnPack,
  type Slots,
} from "../game/draft";
import type { Rng } from "../game/rng";
import type { Pack, RosterPlayer } from "../game/types";

// ---------------------------------------------------------------------------
// The versus draft engine — a pure reducer over plain-JSON state. The room
// server owns *when* (timers, connections); this module owns *what*:
//
//   A spread is revealed: one pack in a 2-4 seat lobby, TWO side-by-side
//   packs with 5+ seats (so late pickers still see real choices). The opener
//   may mulligan the whole spread (before anyone acts). Then, starting at
//   the opener and going around, every seat with an incomplete board takes
//   exactly one action: pick a legal card from anywhere in the spread, Deny
//   any card, or Pass (only when no pick fits). Seats that can do none of
//   those are auto-passed. The spread is then discarded, the opener rotates
//   to the next incomplete seat, and the next spread is revealed — until
//   every board holds 5 players + 5 heroes.
//
//   Players are exclusive across the lobby (takenSteamIds); heroes are
//   shared — only the card in this pack is consumed. A denied player is
//   destroyed for everyone; a denied hero only leaves this pack.
//
//   TURBO mode replaces the shared table with a booster chain: every
//   incomplete seat is dealt its own pack (a wave), everyone picks at once,
//   and each pack's leftovers pass to the next seat — queueing there if that
//   seat is still busy. A pack an arriving seat cannot pick from passes
//   through by itself (the skip rule, no penalty), a pack every seat has
//   acted on is discarded, and a new wave is dealt when the previous one is
//   gone. Deny burns your pick on the pack in your hands; mulligan burns a
//   freshly dealt pack for a replacement before anyone has acted on it.
// ---------------------------------------------------------------------------

export const DENIES_PER_GAME = 1;

export type DraftMode = "classic" | "turbo";

export type CardRef =
  | { kind: "player"; steamId: number }
  | { kind: "hero"; heroId: number };

export type DeniedCard =
  | { kind: "player"; player: RosterPlayer }
  | { kind: "hero"; heroId: number };

export type Action =
  | { type: "pick"; card: CardRef }
  | { type: "deny"; card: CardRef }
  | { type: "pass" }
  | { type: "mulligan" };

export interface Board {
  slots: Slots;
  heroes: number[];
}

export interface EngineState {
  numSeats: number;
  mode: DraftMode;
  /** Packs opened so far (a 2-pack spread advances this by 2). */
  packSeq: number;
  /** Spreads opened so far — what the UI calls the round number. */
  roundSeq: number;
  openerSeat: number;
  turnSeat: number | null;
  /** The open spread: 1 pack for 2-4 seats, 2 packs for 5+. Empty between rounds.
   *  In turbo, every in-flight pack of the current wave. */
  currentPacks: DrawnPack[];
  /** Turbo: the seat each current pack was dealt to (parallel to currentPacks). */
  packDealtTo: number[];
  /** Turbo: how many seats have acted on each current pack (parallel to
   *  currentPacks) — the pack sits `packPassCount` seats down the chain. */
  packPassCount: number[];
  /** Turbo: seats owed a replacement pack after a mulligan. */
  owedPacks: number[];
  /** Seats that have already acted (or been auto-passed) on the current spread. */
  actedSeats: number[];
  boards: Board[];
  takenSteamIds: number[];
  deniedShelf: { card: DeniedCard; bySeat: number; packSeq: number }[];
  mulligansLeft: number[];
  deniesLeft: number[];
  usedPackIds: string[];
  done: boolean;
}

/**
 * The public facts needed to answer "what may this seat do?". Both the full
 * engine state and the wire projection satisfy this interface; callers never
 * need to fabricate the engine's private bookkeeping fields.
 */
export type DraftLegalityState = Pick<
  EngineState,
  | "mode"
  | "openerSeat"
  | "turnSeat"
  | "currentPacks"
  | "packDealtTo"
  | "packPassCount"
  | "boards"
  | "takenSteamIds"
  | "mulligansLeft"
  | "deniesLeft"
>;

export function createDraft(
  numSeats: number,
  config: { mulligans: number; openerSeat?: number; mode?: DraftMode },
): EngineState {
  return {
    numSeats,
    mode: config.mode ?? "classic",
    packSeq: 0,
    roundSeq: 0,
    // Who opens the first spread is the caller's roll; rotation runs from there.
    openerSeat: (((config.openerSeat ?? 0) % numSeats) + numSeats) % numSeats,
    turnSeat: null,
    currentPacks: [],
    packDealtTo: [],
    packPassCount: [],
    owedPacks: [],
    actedSeats: [],
    boards: Array.from({ length: numSeats }, () => ({ slots: emptySlots(), heroes: [] })),
    takenSteamIds: [],
    deniedShelf: [],
    mulligansLeft: Array.from({ length: numSeats }, () => config.mulligans),
    deniesLeft: Array.from({ length: numSeats }, () => DENIES_PER_GAME),
    usedPackIds: [],
    done: false,
  };
}

const takenSet = (s: Pick<EngineState, "takenSteamIds">) => new Set(s.takenSteamIds);

export function boardComplete(b: Board): boolean {
  return isComplete(b.slots, b.heroes);
}

function allBoardsComplete(s: EngineState): boolean {
  return s.boards.every(boardComplete);
}

/** How many packs open per spread: one for small tables, two for 5+ seats. */
export function packsPerSpread(numSeats: number): number {
  return numSeats > 4 ? 2 : 1;
}

function packHasCards(s: DraftLegalityState): boolean {
  return s.currentPacks.some((p) => p.players.length + p.heroes.length > 0);
}

// ---- the turbo chain ----

/** Turbo: the seat currently holding pack i — its deal seat plus one step per act. */
export function packHolder(s: DraftLegalityState, i: number): number {
  return (s.packDealtTo[i] + s.packPassCount[i]) % s.boards.length;
}

/**
 * Turbo: the pack this seat must act on now, or -1. Packs queue in arrival
 * order — the pass count of a held pack IS its chain distance to this seat,
 * so the least-passed pack in hand is the one that got here first.
 */
export function activePackIndex(s: DraftLegalityState, seat: number): number {
  let best = -1;
  for (let i = 0; i < s.currentPacks.length; i++) {
    if (packHolder(s, i) !== seat) continue;
    if (best < 0 || s.packPassCount[i] < s.packPassCount[best]) best = i;
  }
  return best;
}

/** Legal picks for a seat from one specific pack of the wave. */
function packPicks(s: DraftLegalityState, seat: number, packIdx: number): CardRef[] {
  const b = s.boards[seat];
  if (boardComplete(b)) return [];
  const taken = takenSet(s);
  const picks: CardRef[] = [];
  const pack = s.currentPacks[packIdx];
  for (const p of pack.players) {
    if (canPickPlayer(p, b.slots, taken)) picks.push({ kind: "player", steamId: p.steamId });
  }
  for (const h of pack.heroes) {
    if (canPickHero(h, b.heroes)) picks.push({ kind: "hero", heroId: h });
  }
  return picks;
}

/** Legal picks for a seat across the whole spread (off-turn callers get the same answer). */
export function legalPicks(s: DraftLegalityState, seat: number): CardRef[] {
  if (s.mode === "turbo") {
    const i = activePackIndex(s, seat);
    return i >= 0 ? packPicks(s, seat, i) : [];
  }
  if (!s.currentPacks.length) return [];
  const b = s.boards[seat];
  if (boardComplete(b)) return [];
  const taken = takenSet(s);
  const picks: CardRef[] = [];
  const seenHero = new Set<number>();
  for (const pack of s.currentPacks) {
    for (const p of pack.players) {
      if (canPickPlayer(p, b.slots, taken)) picks.push({ kind: "player", steamId: p.steamId });
    }
    for (const h of pack.heroes) {
      if (seenHero.has(h)) continue;
      seenHero.add(h);
      if (canPickHero(h, b.heroes)) picks.push({ kind: "hero", heroId: h });
    }
  }
  return picks;
}

/** Whether this seat's turn should happen at all on the current pack. */
function seatMayAct(s: EngineState, seat: number): boolean {
  if (boardComplete(s.boards[seat])) return false;
  if (legalPicks(s, seat).length > 0) return true;
  return s.deniesLeft[seat] > 0 && packHasCards(s);
}

function nextIncompleteSeat(s: EngineState, from: number): number {
  for (let k = 0; k < s.numSeats; k++) {
    const seat = (from + k) % s.numSeats;
    if (!boardComplete(s.boards[seat])) return seat;
  }
  return from % s.numSeats;
}

/**
 * Move the turn to the next actable seat on the current spread, auto-passing
 * seats with nothing to do. When the spread is exhausted, discard it and
 * rotate the opener; the room server then calls openSpread for the next one.
 */
function advanceTurn(s: EngineState): EngineState {
  if (allBoardsComplete(s)) {
    return { ...s, done: true, turnSeat: null, currentPacks: [] };
  }
  const acted = [...s.actedSeats];
  for (let k = 0; k < s.numSeats; k++) {
    const seat = (s.openerSeat + k) % s.numSeats;
    if (acted.includes(seat)) continue;
    if (seatMayAct({ ...s, actedSeats: acted }, seat)) {
      return { ...s, actedSeats: acted, turnSeat: seat };
    }
    acted.push(seat);
  }
  // Everyone has acted or been auto-passed: the spread is done.
  return {
    ...s,
    actedSeats: acted,
    turnSeat: null,
    currentPacks: [],
    openerSeat: nextIncompleteSeat(s, s.openerSeat + 1),
  };
}

/**
 * Reveal the next spread (1 pack, or 2 side-by-side with 5+ seats).
 * Eligibility for the first pack (soft-lock-proof, extending the solo
 * filtered draw): a pack the opener can pick from → a pack any incomplete
 * seat can pick from → any unused pack. A second pack never shares a player
 * with the first (a steamId must identify one card), and its displayed
 * heroes are deduped against the first's.
 */
export function openSpread(s: EngineState, pool: Pack[], rng: Rng): EngineState {
  if (s.done || s.currentPacks.length) return s;
  const used = new Set(s.usedPackIds);
  const taken = takenSet(s);
  const opener = s.boards[s.openerSeat];
  const drawn: DrawnPack[] = [];
  const chosen: Pack[] = [];

  for (let k = 0; k < packsPerSpread(s.numSeats); k++) {
    let unused = pool.filter((p) => !used.has(p.id));
    // pool exhausted (practically unreachable): allow repeats, minus this spread
    if (!unused.length) unused = pool.filter((p) => !chosen.some((c) => c.id === p.id));
    if (!unused.length) break;
    const sharesPlayer = (p: Pack) =>
      chosen.some((c) => c.players.some((cp) => p.players.some((pp) => pp.steamId === cp.steamId)));
    const distinct = unused.filter((p) => !sharesPlayer(p));
    const candidates = distinct.length ? distinct : unused;
    let source = candidates;
    if (k === 0) {
      const openerOk = candidates.filter((p) =>
        packPickable(p, opener.slots, opener.heroes, taken),
      );
      const anyOk = openerOk.length
        ? openerOk
        : candidates.filter((p) =>
            s.boards.some((b) => !boardComplete(b) && packPickable(p, b.slots, b.heroes, taken)),
          );
      source = anyOk.length ? anyOk : candidates;
    }
    const pack = source[Math.floor(rng() * source.length)];
    used.add(pack.id);
    chosen.push(pack);
    let d = materialize(pack, rng);
    if (k === 0) {
      // The 5-of-N hero shuffle can hide the opener's only pickable card — swap one in.
      const openerCanPick =
        d.players.some((p) => canPickPlayer(p, opener.slots, taken)) ||
        d.heroes.some((h) => canPickHero(h, opener.heroes));
      if (!openerCanPick) {
        const swap = pack.signatureHeroes.find((h) => canPickHero(h, opener.heroes));
        if (swap != null) d = { ...d, heroes: [...d.heroes.slice(0, d.heroes.length - 1), swap] };
      }
    } else {
      // Don't show the same hero twice across the spread.
      const shown = new Set(drawn.flatMap((x) => x.heroes));
      if (d.heroes.some((h) => shown.has(h))) {
        const kept = d.heroes.filter((h) => !shown.has(h));
        const extras = pack.signatureHeroes.filter((h) => !shown.has(h) && !kept.includes(h));
        while (kept.length < d.heroes.length && extras.length) kept.push(extras.shift()!);
        d = { ...d, heroes: kept };
      }
    }
    drawn.push(d);
  }

  return advanceTurn({
    ...s,
    currentPacks: drawn,
    actedSeats: [],
    turnSeat: null,
    usedPackIds: [...used],
    packSeq: s.packSeq + drawn.length,
    roundSeq: s.roundSeq + 1,
  });
}

/**
 * Turbo: run the chain until it is stable — discard packs every seat has
 * acted on, pass packs their holder cannot pick from (the skip rule, no
 * penalty), and finish the draft the moment every board holds 5+5 (any
 * packs still in flight are simply dropped).
 */
function settleTurbo(s: EngineState): EngineState {
  if (allBoardsComplete(s)) {
    return {
      ...s,
      done: true,
      turnSeat: null,
      currentPacks: [],
      packDealtTo: [],
      packPassCount: [],
      owedPacks: [],
    };
  }
  const next = {
    ...s,
    currentPacks: [...s.currentPacks],
    packDealtTo: [...s.packDealtTo],
    packPassCount: [...s.packPassCount],
  };
  for (let i = 0; i < next.currentPacks.length; ) {
    if (next.packPassCount[i] >= next.numSeats) {
      next.currentPacks.splice(i, 1);
      next.packDealtTo.splice(i, 1);
      next.packPassCount.splice(i, 1);
      continue; // re-check the pack that slid into i
    }
    if (packPicks(next, packHolder(next, i), i).length === 0) {
      next.packPassCount[i]++;
      continue; // same pack, next seat down the chain
    }
    i++;
  }
  return next;
}

/**
 * Turbo dealing: replacements owed by mulligans first, otherwise a fresh
 * wave — one pack per incomplete seat, dealt to that seat. Empty between
 * waves, the room server calls this like it calls openSpread.
 */
export function dealTurbo(s: EngineState, pool: Pack[], rng: Rng): EngineState {
  if (s.done) return s;
  let next = s;
  if (s.owedPacks.length) {
    for (const seat of s.owedPacks) next = dealPackTo(next, seat, pool, rng);
    next = { ...next, owedPacks: [] };
  } else if (!s.currentPacks.length) {
    next = { ...next, roundSeq: next.roundSeq + 1 };
    for (let seat = 0; seat < s.numSeats; seat++) {
      if (!boardComplete(next.boards[seat])) next = dealPackTo(next, seat, pool, rng);
    }
  }
  return settleTurbo(next);
}

/**
 * Draw one pack for one seat. Eligibility mirrors openSpread's soft-lock-proof
 * filtered draw: a pack this seat can pick from → a pack any incomplete seat
 * can pick from → any unused pack. In-flight packs never share a player (a
 * steamId must identify one card), and the 5-of-N hero shuffle is corrected
 * so a pack that qualified via its heroes shows this seat a pickable one.
 */
function dealPackTo(s: EngineState, seat: number, pool: Pack[], rng: Rng): EngineState {
  const used = new Set(s.usedPackIds);
  const taken = takenSet(s);
  const b = s.boards[seat];
  let unused = pool.filter((p) => !used.has(p.id));
  // pool exhausted (practically unreachable): allow repeats, minus in-flight
  if (!unused.length) unused = pool.filter((p) => !s.currentPacks.some((c) => c.id === p.id));
  if (!unused.length) return s;
  const inFlight = new Set(s.currentPacks.flatMap((p) => p.players.map((x) => x.steamId)));
  const distinct = unused.filter((p) => !p.players.some((x) => inFlight.has(x.steamId)));
  const candidates = distinct.length ? distinct : unused;
  const mineOk = candidates.filter((p) => packPickable(p, b.slots, b.heroes, taken));
  const anyOk = mineOk.length
    ? mineOk
    : candidates.filter((p) =>
        s.boards.some((bb) => !boardComplete(bb) && packPickable(p, bb.slots, bb.heroes, taken)),
      );
  const source = anyOk.length ? anyOk : candidates;
  const pack = source[Math.floor(rng() * source.length)];
  let d = materialize(pack, rng);
  const canPick =
    d.players.some((p) => canPickPlayer(p, b.slots, taken)) ||
    d.heroes.some((h) => canPickHero(h, b.heroes));
  if (!canPick) {
    const swap = pack.signatureHeroes.find((h) => canPickHero(h, b.heroes));
    if (swap != null) d = { ...d, heroes: [...d.heroes.slice(0, d.heroes.length - 1), swap] };
  }
  return {
    ...s,
    currentPacks: [...s.currentPacks, d],
    packDealtTo: [...s.packDealtTo, seat],
    packPassCount: [...s.packPassCount, 0],
    usedPackIds: [...s.usedPackIds, pack.id],
    packSeq: s.packSeq + 1,
  };
}

export function legalActions(
  s: DraftLegalityState,
  seat: number,
): { picks: CardRef[]; canDeny: boolean; canPass: boolean; canMulligan: boolean } {
  if (s.mode === "turbo") {
    const i = activePackIndex(s, seat);
    const picks = i >= 0 ? packPicks(s, seat, i) : [];
    return {
      picks,
      // Deny replaces your pick, so only the pack in your hands qualifies.
      canDeny: picks.length > 0 && s.deniesLeft[seat] > 0,
      // A pack you cannot pick from never reaches you — it passes by itself.
      canPass: false,
      // "Before anyone acts": zero passes means you are its first holder.
      canMulligan: i >= 0 && s.packPassCount[i] === 0 && s.mulligansLeft[seat] > 0,
    };
  }
  const myTurn = s.turnSeat === seat && s.currentPacks.length > 0;
  const picks = myTurn ? legalPicks(s, seat) : [];
  return {
    picks,
    canDeny: myTurn && s.deniesLeft[seat] > 0 && packHasCards(s),
    canPass: myTurn && picks.length === 0,
    // "Before anyone acts" is guaranteed by turnSeat === openerSeat: the opener always acts first.
    canMulligan:
      s.currentPacks.length > 0 &&
      seat === s.openerSeat &&
      s.turnSeat === s.openerSeat &&
      s.mulligansLeft[seat] > 0,
  };
}

/** Index of the spread pack holding this card, or -1. */
function packWithCard(s: EngineState, card: CardRef): number {
  return s.currentPacks.findIndex((p) =>
    card.kind === "player"
      ? p.players.some((x) => x.steamId === card.steamId)
      : p.heroes.includes(card.heroId),
  );
}

function replacePack(packs: DrawnPack[], idx: number, next: DrawnPack): DrawnPack[] {
  const out = [...packs];
  out[idx] = next;
  return out;
}

function fail(s: EngineState, error: string): { state: EngineState; error: string } {
  return { state: s, error };
}

function sameRef(a: CardRef, b: CardRef): boolean {
  return (
    (a.kind === "player" && b.kind === "player" && a.steamId === b.steamId) ||
    (a.kind === "hero" && b.kind === "hero" && a.heroId === b.heroId)
  );
}

/** Move a card from pack `pi` onto this seat's board (no turn bookkeeping). */
function pickCard(s: EngineState, seat: number, pi: number, card: CardRef): EngineState {
  const pack = s.currentPacks[pi];
  const boards = [...s.boards];
  if (card.kind === "player") {
    const p = pack.players.find((x) => x.steamId === card.steamId)!;
    const slot = slotForRole(p.role, boards[seat].slots)!;
    boards[seat] = { ...boards[seat], slots: { ...boards[seat].slots, [slot]: p } };
    return {
      ...s,
      boards,
      takenSteamIds: [...s.takenSteamIds, p.steamId],
      currentPacks: replacePack(s.currentPacks, pi, {
        ...pack,
        players: pack.players.filter((x) => x.steamId !== p.steamId),
      }),
    };
  }
  const heroId = card.heroId;
  boards[seat] = { ...boards[seat], heroes: [...boards[seat].heroes, heroId] };
  return {
    ...s,
    boards,
    currentPacks: replacePack(s.currentPacks, pi, {
      ...pack,
      heroes: pack.heroes.filter((h) => h !== heroId),
    }),
  };
}

/** Destroy a card in pack `pi` onto the shelf (no turn bookkeeping). */
function denyCard(s: EngineState, seat: number, pi: number, card: CardRef): EngineState {
  const pack = s.currentPacks[pi];
  const deniesLeft = [...s.deniesLeft];
  deniesLeft[seat]--;
  if (card.kind === "player") {
    const p = pack.players.find((x) => x.steamId === card.steamId)!;
    return {
      ...s,
      deniesLeft,
      takenSteamIds: [...s.takenSteamIds, p.steamId], // destroyed for everyone
      deniedShelf: [
        ...s.deniedShelf,
        { card: { kind: "player", player: p }, bySeat: seat, packSeq: s.packSeq },
      ],
      currentPacks: replacePack(s.currentPacks, pi, {
        ...pack,
        players: pack.players.filter((x) => x.steamId !== p.steamId),
      }),
    };
  }
  const heroId = card.heroId;
  return {
    ...s,
    deniesLeft,
    deniedShelf: [
      ...s.deniedShelf,
      { card: { kind: "hero", heroId }, bySeat: seat, packSeq: s.packSeq },
    ],
    currentPacks: replacePack(s.currentPacks, pi, {
      ...pack,
      heroes: pack.heroes.filter((h) => h !== heroId),
    }),
  };
}

export function applyAction(
  s: EngineState,
  seat: number,
  action: Action,
): { state: EngineState; error?: string } {
  if (s.done) return fail(s, "draft-finished");
  if (s.mode === "turbo") return applyTurbo(s, seat, action);
  if (!s.currentPacks.length) return fail(s, "no-pack");
  if (seat < 0 || seat >= s.numSeats) return fail(s, "bad-seat");
  const legal = legalActions(s, seat);

  if (action.type === "mulligan") {
    if (!legal.canMulligan) return fail(s, "illegal-mulligan");
    const mulligansLeft = [...s.mulligansLeft];
    mulligansLeft[seat]--;
    // Same opener re-opens; the burned spread stays in usedPackIds.
    return { state: { ...s, mulligansLeft, currentPacks: [], actedSeats: [], turnSeat: null } };
  }

  if (s.turnSeat !== seat) return fail(s, "not-your-turn");

  if (action.type === "pass") {
    if (!legal.canPass) return fail(s, "cannot-pass");
    return { state: advanceTurn({ ...s, actedSeats: [...s.actedSeats, seat] }) };
  }

  if (action.type === "pick") {
    if (!legal.picks.some((c) => sameRef(c, action.card))) return fail(s, "illegal-pick");
    const pi = packWithCard(s, action.card);
    if (pi < 0) return fail(s, "card-not-in-pack");
    const next = pickCard(s, seat, pi, action.card);
    return { state: advanceTurn({ ...next, actedSeats: [...s.actedSeats, seat] }) };
  }

  if (action.type === "deny") {
    if (!legal.canDeny) return fail(s, "cannot-deny");
    const pi = packWithCard(s, action.card);
    if (pi < 0) return fail(s, "card-not-in-pack");
    const next = denyCard(s, seat, pi, action.card);
    return { state: advanceTurn({ ...next, actedSeats: [...s.actedSeats, seat] }) };
  }

  return fail(s, "unknown-action");
}

/**
 * Turbo actions run against the pack in the seat's hands — there is no shared
 * turn, so any seat holding a pack may act at any moment. Acting counts as
 * this seat's pass on that pack: the leftovers move down the chain.
 */
function applyTurbo(
  s: EngineState,
  seat: number,
  action: Action,
): { state: EngineState; error?: string } {
  if (seat < 0 || seat >= s.numSeats) return fail(s, "bad-seat");
  const pi = activePackIndex(s, seat);
  if (pi < 0) return fail(s, "no-pack");
  const legal = legalActions(s, seat);

  // A pack with nothing for you never waits in your hands — it passes itself.
  if (action.type === "pass") return fail(s, "cannot-pass");

  if (action.type === "mulligan") {
    if (!legal.canMulligan) return fail(s, "illegal-mulligan");
    const mulligansLeft = [...s.mulligansLeft];
    mulligansLeft[seat]--;
    // Burn the freshly dealt pack; the room deals this seat a replacement.
    return {
      state: settleTurbo({
        ...s,
        mulligansLeft,
        currentPacks: s.currentPacks.filter((_, i) => i !== pi),
        packDealtTo: s.packDealtTo.filter((_, i) => i !== pi),
        packPassCount: s.packPassCount.filter((_, i) => i !== pi),
        owedPacks: [...s.owedPacks, seat],
      }),
    };
  }

  const passOn = (next: EngineState): EngineState =>
    settleTurbo({
      ...next,
      packPassCount: next.packPassCount.map((c, i) => (i === pi ? c + 1 : c)),
    });

  if (action.type === "pick") {
    if (!legal.picks.some((c) => sameRef(c, action.card))) return fail(s, "illegal-pick");
    return { state: passOn(pickCard(s, seat, pi, action.card)) };
  }

  if (action.type === "deny") {
    if (!legal.canDeny) return fail(s, "cannot-deny");
    const card = action.card;
    const inPack =
      card.kind === "player"
        ? s.currentPacks[pi].players.some((x) => x.steamId === card.steamId)
        : s.currentPacks[pi].heroes.includes(card.heroId);
    if (!inPack) return fail(s, "card-not-in-pack");
    return { state: passOn(denyCard(s, seat, pi, card)) };
  }

  return fail(s, "unknown-action");
}

export function isDraftDone(s: EngineState): boolean {
  return s.done;
}

/** Roster in slot order for a completed board (for computeStrength). */
export function boardRoster(b: Board) {
  return SLOT_IDS.map((slot) => b.slots[slot]).filter(
    (p): p is NonNullable<typeof p> => p != null,
  );
}
