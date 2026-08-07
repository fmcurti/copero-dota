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
} from "../game/draft";
import type { Rng } from "../game/rng";
import type { Pack } from "../game/types";
import { DENIES_PER_GAME, type Action, type Board, type CardRef, type DeniedCard } from "./protocol";

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
// ---------------------------------------------------------------------------

export interface EngineState {
  numSeats: number;
  /** Packs opened so far (a 2-pack spread advances this by 2). */
  packSeq: number;
  /** Spreads opened so far — what the UI calls the round number. */
  roundSeq: number;
  openerSeat: number;
  turnSeat: number | null;
  /** The open spread: 1 pack for 2-4 seats, 2 packs for 5+. Empty between rounds. */
  currentPacks: DrawnPack[];
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

export function createDraft(numSeats: number, config: { mulligans: number }): EngineState {
  return {
    numSeats,
    packSeq: 0,
    roundSeq: 0,
    openerSeat: 0,
    turnSeat: null,
    currentPacks: [],
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

const takenSet = (s: EngineState) => new Set(s.takenSteamIds);

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

function packHasCards(s: EngineState): boolean {
  return s.currentPacks.some((p) => p.players.length + p.heroes.length > 0);
}

/** Legal picks for a seat across the whole spread (off-turn callers get the same answer). */
export function legalPicks(s: EngineState, seat: number): CardRef[] {
  if (!s.currentPacks.length || s.done) return [];
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

export function legalActions(
  s: EngineState,
  seat: number,
): { picks: CardRef[]; canDeny: boolean; canPass: boolean; canMulligan: boolean } {
  const myTurn = !s.done && s.turnSeat === seat && s.currentPacks.length > 0;
  const picks = myTurn ? legalPicks(s, seat) : [];
  return {
    picks,
    canDeny: myTurn && s.deniesLeft[seat] > 0 && packHasCards(s),
    canPass: myTurn && picks.length === 0,
    // "Before anyone acts" is guaranteed by turnSeat === openerSeat: the opener always acts first.
    canMulligan:
      !s.done &&
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

export function applyAction(
  s: EngineState,
  seat: number,
  action: Action,
): { state: EngineState; error?: string } {
  if (s.done) return fail(s, "draft-finished");
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
    const ok = legal.picks.some(
      (c) =>
        (c.kind === "player" &&
          action.card.kind === "player" &&
          c.steamId === action.card.steamId) ||
        (c.kind === "hero" && action.card.kind === "hero" && c.heroId === action.card.heroId),
    );
    if (!ok) return fail(s, "illegal-pick");
    const pi = packWithCard(s, action.card);
    if (pi < 0) return fail(s, "card-not-in-pack");
    const pack = s.currentPacks[pi];
    const boards = [...s.boards];
    let next: EngineState;
    if (action.card.kind === "player") {
      const steamId = action.card.steamId;
      const p = pack.players.find((x) => x.steamId === steamId)!;
      const slot = slotForRole(p.role, boards[seat].slots)!;
      boards[seat] = { ...boards[seat], slots: { ...boards[seat].slots, [slot]: p } };
      next = {
        ...s,
        boards,
        takenSteamIds: [...s.takenSteamIds, p.steamId],
        currentPacks: replacePack(s.currentPacks, pi, {
          ...pack,
          players: pack.players.filter((x) => x.steamId !== p.steamId),
        }),
      };
    } else {
      const heroId = action.card.heroId;
      boards[seat] = { ...boards[seat], heroes: [...boards[seat].heroes, heroId] };
      next = {
        ...s,
        boards,
        currentPacks: replacePack(s.currentPacks, pi, {
          ...pack,
          heroes: pack.heroes.filter((h) => h !== heroId),
        }),
      };
    }
    return { state: advanceTurn({ ...next, actedSeats: [...s.actedSeats, seat] }) };
  }

  if (action.type === "deny") {
    if (!legal.canDeny) return fail(s, "cannot-deny");
    const deniesLeft = [...s.deniesLeft];
    deniesLeft[seat]--;
    const card = action.card;
    const pi = packWithCard(s, card);
    if (pi < 0) return fail(s, "card-not-in-pack");
    const pack = s.currentPacks[pi];
    let next: EngineState;
    if (card.kind === "player") {
      const p = pack.players.find((x) => x.steamId === card.steamId)!;
      next = {
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
    } else {
      const heroId = card.heroId;
      next = {
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
    return { state: advanceTurn({ ...next, actedSeats: [...s.actedSeats, seat] }) };
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
