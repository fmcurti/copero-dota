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
//   A pack is revealed. The opener may mulligan it (before anyone acts).
//   Then, starting at the opener and going around, every seat with an
//   incomplete board takes exactly one action: pick a legal card, Deny any
//   card, or Pass (only when no pick fits). Seats that can do none of those
//   are auto-passed. The pack is then discarded, the opener rotates to the
//   next incomplete seat, and the next pack is revealed — until every board
//   holds 5 players + 5 heroes.
//
//   Players are exclusive across the lobby (takenSteamIds); heroes are
//   shared — only the card in this pack is consumed. A denied player is
//   destroyed for everyone; a denied hero only leaves this pack.
// ---------------------------------------------------------------------------

export interface EngineState {
  numSeats: number;
  packSeq: number;
  openerSeat: number;
  turnSeat: number | null;
  currentPack: DrawnPack | null;
  /** Seats that have already acted (or been auto-passed) on the current pack. */
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
    openerSeat: 0,
    turnSeat: null,
    currentPack: null,
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

function packHasCards(s: EngineState): boolean {
  const p = s.currentPack;
  return !!p && p.players.length + p.heroes.length > 0;
}

/** Legal picks for a seat from the current pack (empty off-turn callers get the same answer). */
export function legalPicks(s: EngineState, seat: number): CardRef[] {
  const pack = s.currentPack;
  if (!pack || s.done) return [];
  const b = s.boards[seat];
  if (boardComplete(b)) return [];
  const taken = takenSet(s);
  const picks: CardRef[] = [];
  for (const p of pack.players) {
    if (canPickPlayer(p, b.slots, taken)) picks.push({ kind: "player", steamId: p.steamId });
  }
  for (const h of pack.heroes) {
    if (canPickHero(h, b.heroes)) picks.push({ kind: "hero", heroId: h });
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
 * Move the turn to the next actable seat on the current pack, auto-passing
 * seats with nothing to do. When the pack is exhausted, discard it and rotate
 * the opener; the room server then calls openPack for the next one.
 */
function advanceTurn(s: EngineState): EngineState {
  if (allBoardsComplete(s)) {
    return { ...s, done: true, turnSeat: null, currentPack: null };
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
  // Everyone has acted or been auto-passed: the pack is done.
  return {
    ...s,
    actedSeats: acted,
    turnSeat: null,
    currentPack: null,
    openerSeat: nextIncompleteSeat(s, s.openerSeat + 1),
  };
}

/**
 * Reveal the next pack. Preference order for eligibility (soft-lock-proof,
 * extending the solo filtered draw): a pack the opener can pick from → a pack
 * any incomplete seat can pick from → any unused pack.
 */
export function openPack(s: EngineState, pool: Pack[], rng: Rng): EngineState {
  if (s.done || s.currentPack) return s;
  const used = new Set(s.usedPackIds);
  let unused = pool.filter((p) => !used.has(p.id));
  if (!unused.length) unused = pool; // pool exhausted (practically unreachable): allow repeats
  const taken = takenSet(s);
  const opener = s.boards[s.openerSeat];
  const openerOk = unused.filter((p) => packPickable(p, opener.slots, opener.heroes, taken));
  const anyOk = openerOk.length
    ? openerOk
    : unused.filter((p) =>
        s.boards.some((b) => !boardComplete(b) && packPickable(p, b.slots, b.heroes, taken)),
      );
  const source = anyOk.length ? anyOk : unused;
  const pack = source[Math.floor(rng() * source.length)];
  let drawn = materialize(pack, rng);
  // The 5-of-N hero shuffle can hide the opener's only pickable card — swap one in.
  const openerCanPick =
    drawn.players.some((p) => canPickPlayer(p, opener.slots, taken)) ||
    drawn.heroes.some((h) => canPickHero(h, opener.heroes));
  if (!openerCanPick) {
    const swap = pack.signatureHeroes.find((h) => canPickHero(h, opener.heroes));
    if (swap != null) {
      drawn = { ...drawn, heroes: [...drawn.heroes.slice(0, drawn.heroes.length - 1), swap] };
    }
  }
  return advanceTurn({
    ...s,
    currentPack: drawn,
    actedSeats: [],
    turnSeat: null,
    usedPackIds: [...s.usedPackIds, pack.id],
    packSeq: s.packSeq + 1,
  });
}

export function legalActions(
  s: EngineState,
  seat: number,
): { picks: CardRef[]; canDeny: boolean; canPass: boolean; canMulligan: boolean } {
  const myTurn = !s.done && s.turnSeat === seat && s.currentPack != null;
  const picks = myTurn ? legalPicks(s, seat) : [];
  return {
    picks,
    canDeny: myTurn && s.deniesLeft[seat] > 0 && packHasCards(s),
    canPass: myTurn && picks.length === 0,
    // "Before anyone acts" is guaranteed by turnSeat === openerSeat: the opener always acts first.
    canMulligan:
      !s.done &&
      s.currentPack != null &&
      seat === s.openerSeat &&
      s.turnSeat === s.openerSeat &&
      s.mulligansLeft[seat] > 0,
  };
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
  const pack = s.currentPack;
  if (!pack) return fail(s, "no-pack");
  if (seat < 0 || seat >= s.numSeats) return fail(s, "bad-seat");
  const legal = legalActions(s, seat);

  if (action.type === "mulligan") {
    if (!legal.canMulligan) return fail(s, "illegal-mulligan");
    const mulligansLeft = [...s.mulligansLeft];
    mulligansLeft[seat]--;
    // Same opener re-opens; the burned pack stays in usedPackIds.
    return { state: { ...s, mulligansLeft, currentPack: null, actedSeats: [], turnSeat: null } };
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
        currentPack: { ...pack, players: pack.players.filter((x) => x.steamId !== p.steamId) },
      };
    } else {
      const heroId = action.card.heroId;
      boards[seat] = { ...boards[seat], heroes: [...boards[seat].heroes, heroId] };
      next = {
        ...s,
        boards,
        currentPack: { ...pack, heroes: pack.heroes.filter((h) => h !== heroId) },
      };
    }
    return { state: advanceTurn({ ...next, actedSeats: [...s.actedSeats, seat] }) };
  }

  if (action.type === "deny") {
    if (!legal.canDeny) return fail(s, "cannot-deny");
    const deniesLeft = [...s.deniesLeft];
    deniesLeft[seat]--;
    const card = action.card;
    let next: EngineState;
    if (card.kind === "player") {
      const p = pack.players.find((x) => x.steamId === card.steamId);
      if (!p) return fail(s, "card-not-in-pack");
      next = {
        ...s,
        deniesLeft,
        takenSteamIds: [...s.takenSteamIds, p.steamId], // destroyed for everyone
        deniedShelf: [
          ...s.deniedShelf,
          { card: { kind: "player", player: p }, bySeat: seat, packSeq: s.packSeq },
        ],
        currentPack: { ...pack, players: pack.players.filter((x) => x.steamId !== p.steamId) },
      };
    } else {
      const heroId = card.heroId;
      if (!pack.heroes.includes(heroId)) return fail(s, "card-not-in-pack");
      next = {
        ...s,
        deniesLeft,
        deniedShelf: [
          ...s.deniedShelf,
          { card: { kind: "hero", heroId }, bySeat: seat, packSeq: s.packSeq },
        ],
        currentPack: { ...pack, heroes: pack.heroes.filter((h) => h !== heroId) },
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
