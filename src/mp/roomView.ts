import { SLOT_IDS } from "../game/draft";
import type { OwnerStats, RunRecord, SimResult } from "../game/types";
import type { RoomSnapshot, Seat } from "./protocol";

// ---------------------------------------------------------------------------
// The Room view module: everything the Room page decides that is not
// rendering. `deriveRoomView` answers "what does this snapshot mean to this
// player"; the cue functions answer "what should happen now that the facts
// changed". Both are pure — the page executes cues through its adapters
// (socket, announcer, localStorage, run history) and renders the view.
// ---------------------------------------------------------------------------

export interface HumanStanding {
  seat: Seat;
  seatIdx: number;
  stats: OwnerStats;
}

export interface RoomView {
  /** My seat index, or -1 when spectating. */
  mySeat: number;
  seated: boolean;
  isHost: boolean;
  isSpectator: boolean;
  /** My seat's team name, or "Spectator". */
  myName: string;
  /**
   * The humans' final table, best first — only populated once a `result`
   * is available. A shared placement (a 9–12th) is broken by games won, so
   * the row at the top always has the best tournament behind it.
   */
  standings: HumanStanding[];
}

export function deriveRoomView(
  snapshot: RoomSnapshot,
  playerId: string,
  result?: SimResult | null,
): RoomView {
  const mySeat = snapshot.seats.findIndex((s) => s.playerId === playerId);
  const standings = result
    ? snapshot.seats
        .map((seat, seatIdx) => ({ seat, seatIdx, stats: result.ownerStats[seat.playerId] }))
        .filter((x): x is HumanStanding => x.stats != null)
        .sort((a, b) => a.stats.place - b.stats.place || b.stats.gamesWon - a.stats.gamesWon)
    : [];
  return {
    mySeat,
    seated: mySeat >= 0,
    isHost: mySeat >= 0 && snapshot.seats[mySeat].isHost,
    isSpectator: mySeat < 0,
    myName: mySeat >= 0 ? snapshot.seats[mySeat].name : "Spectator",
    standings,
  };
}

// ---------------------------------------------------------------------------
// My run record — the history entry a finished room writes locally.
// ---------------------------------------------------------------------------

/** One record per (room, sim): the executor skips a key it has seen. */
export function runRecordKey(code: string, simSeed: number): string {
  return `copero-mp-recorded:${code}:${simSeed}`;
}

/** Assemble my RunRecord from a finished room, or null when I have no team in it. */
export function runRecordOf(
  snapshot: RoomSnapshot,
  result: SimResult,
  playerId: string,
  now: number,
): RunRecord | null {
  const mySeat = snapshot.seats.findIndex((s) => s.playerId === playerId);
  if (mySeat < 0) return null;
  const stats = result.ownerStats[playerId];
  if (!stats) return null;
  const seats = snapshot.seats;
  const board = snapshot.draft?.boards[mySeat];
  const strength = snapshot.strengths?.[mySeat];
  return {
    id: result.seed,
    date: now,
    place: stats.place,
    label: `${stats.label} · vs ${seats.length - 1} amigo${seats.length > 2 ? "s" : ""}`,
    overall: strength?.overall ?? 0,
    undefeated: stats.undefeated,
    flawlessGroup: stats.flawlessGroup,
    gamesWon: stats.gamesWon,
    gamesLost: stats.gamesLost,
    champion: result.champion.name,
    config: {
      format: snapshot.config.format,
      cardMode: snapshot.config.cardMode,
      rerolls: 0,
      heroAlloc: snapshot.config.heroAlloc,
    },
    roster: board
      ? SLOT_IDS.map((slot, playerIndex) => {
          const p = board.slots[slot];
          return p
            ? {
                nickname: p.nickname,
                steamId: p.steamId,
                role: p.role,
                ovr: p.ovr,
                heroId: strength?.assignment[playerIndex]?.heroId ?? null,
              }
            : { nickname: "—", steamId: 0, role: "support" as const, ovr: 0, heroId: null };
        })
      : [],
  };
}

// ---------------------------------------------------------------------------
// Room cues — compare the client's facts before and after a change and say
// what should happen. The executor owns HOW (sockets, storage, state).
// ---------------------------------------------------------------------------

/** Everything the room page knows that cues depend on. */
export interface ClientFacts {
  snapshot: RoomSnapshot | null;
  result: SimResult | null;
  playerId: string;
  code: string;
  /** Socket (re)connect count — a bump means the server may have lost state. */
  opens: number;
  /** My win phrases, newline-joined ("" = none). */
  phrasesKey: string;
}

export type RoomCue =
  /** The draft just fired — play the stinger. */
  | { kind: "stinger" }
  /**
   * (Re)send my win phrases. Fires on taking a seat and on every reconnect:
   * a reconnect can mean the server restarted (deploy, eviction) or an
   * earlier send was never accepted — without the re-send, the room would
   * stay phraseless forever.
   */
  | { kind: "syncPhrases"; phrases: string[] }
  /**
   * Write my result to local history. Emitted on every done-phase change —
   * the executor dedupes on `dedupeKey`, which also survives reloads.
   */
  | { kind: "recordRun"; dedupeKey: string; record: RunRecord };

export function roomCues(prev: ClientFacts | null, next: ClientFacts, now: number): RoomCue[] {
  const cues: RoomCue[] = [];
  const seatedIn = (f: ClientFacts | null) =>
    f?.snapshot?.seats.some((s) => s.playerId === f.playerId) ?? false;

  if (prev?.snapshot?.phase === "lobby" && next.snapshot?.phase === "drafting") {
    cues.push({ kind: "stinger" });
  }

  const seated = seatedIn(next);
  if (
    seated &&
    (prev == null ||
      !seatedIn(prev) ||
      prev.opens !== next.opens ||
      prev.phrasesKey !== next.phrasesKey)
  ) {
    cues.push({
      kind: "syncPhrases",
      phrases: next.phrasesKey ? next.phrasesKey.split("\n") : [],
    });
  }

  if (next.snapshot?.phase === "done" && next.result) {
    const record = runRecordOf(next.snapshot, next.result, next.playerId, now);
    if (record) {
      cues.push({
        kind: "recordRun",
        dedupeKey: runRecordKey(next.code, next.result.seed),
        record,
      });
    }
  }

  return cues;
}

// ---------------------------------------------------------------------------
// Draft cues — the announcer rule. "Your turn to pick" once per turn, "Five
// seconds remaining" once per turn when the clock runs low. Keyed by
// round+seat so back-to-back turns across rounds re-announce but mulligan
// replacements (same round, same seat) don't.
// ---------------------------------------------------------------------------

export type AnnouncerClip = "yourTurn" | "fiveSeconds";

export interface DraftCueState {
  announcedTurn: string | null;
  warnedTurn: string | null;
}

export const NO_DRAFT_CUES: DraftCueState = { announcedTurn: null, warnedTurn: null };

export function draftCues(
  prev: DraftCueState,
  facts: { myTurn: boolean; roundSeq: number; turnSeat: number | null; secsLeft: number | null },
): { state: DraftCueState; announce: AnnouncerClip[] } {
  if (!facts.myTurn) return { state: prev, announce: [] };
  const key = `${facts.roundSeq}:${facts.turnSeat}`;
  const announce: AnnouncerClip[] = [];
  let state = prev;
  if (state.announcedTurn !== key) {
    state = { ...state, announcedTurn: key };
    announce.push("yourTurn");
  }
  if (
    facts.secsLeft != null &&
    facts.secsLeft > 0 &&
    facts.secsLeft <= 5 &&
    state.warnedTurn !== key
  ) {
    state = { ...state, warnedTurn: key };
    announce.push("fiveSeconds");
  }
  return { state, announce };
}
