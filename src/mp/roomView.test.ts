import { describe, expect, it } from "vitest";
import { simulateTournament } from "../game/sim";
import type { RosterPlayer, SimResult, SimTeam, TeamStrength } from "../game/types";
import { DEFAULT_MP_CONFIG, type RoomSnapshot, type Seat } from "./protocol";
import {
  NO_DRAFT_CUES,
  deriveRoomView,
  draftCues,
  roomCues,
  runRecordKey,
  runRecordOf,
  type ClientFacts,
} from "./roomView";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const seat = (playerId: string, name: string, isHost = false): Seat => ({
  playerId,
  name,
  connected: true,
  isHost,
});

function snap(over: Partial<RoomSnapshot> = {}): RoomSnapshot {
  return {
    phase: "lobby",
    config: DEFAULT_MP_CONFIG,
    seats: [seat("A", "Alice", true), seat("B", "Bo")],
    draft: null,
    strengths: null,
    heroAssignments: null,
    field: null,
    simSeed: null,
    beat: null,
    ...over,
  };
}

const team = (id: string, strength: number, ownerId: string | null): SimTeam => ({
  id,
  name: id,
  strength,
  isUser: false,
  ownerId,
});

/** A real sim with Alice's and Bo's teams in the field. */
const field = [
  team("alice", 90, "A"),
  team("bo", 90, "B"),
  ...Array.from({ length: 16 }, (_, i) => team(`bot${i}`, 86, null)),
];
const result = simulateTournament(field, 31337);

/** Just enough of a SimResult to steer standings deterministically. */
const statsOnly = (ownerStats: SimResult["ownerStats"]) => ({ ownerStats }) as SimResult;

const roster = (base: number): RosterPlayer[] =>
  (["safelane", "mid", "offlane", "support", "support"] as const).map((role, i) => ({
    steamId: base + i,
    nickname: `p${base + i}`,
    role,
    ovr: 80 + i,
    impact: 70,
    economy: 70,
    reliability: 70,
    games: 50,
    team: "T",
    eventId: null,
  }));

function boardAndStrength(base: number) {
  const players = roster(base);
  const board = {
    slots: {
      safelane: players[0],
      mid: players[1],
      offlane: players[2],
      support1: players[3],
      support2: players[4],
    },
    heroes: [11, 12, 13, 14, 15],
  };
  const strength: TeamStrength = {
    overall: 87,
    base: 81,
    heroBonus: 4,
    chemBonus: 2,
    assignment: [11, 12, 13, 14, 15].map((heroId) => ({ heroId, games: 30 })),
    chemEdges: [],
    chemTop: [],
  };
  return { board, strength };
}

// ---------------------------------------------------------------------------
// deriveRoomView
// ---------------------------------------------------------------------------

describe("deriveRoomView", () => {
  it("derives my seat facts for host, guest, and spectator", () => {
    const s = snap();
    expect(deriveRoomView(s, "A")).toMatchObject({
      mySeat: 0,
      seated: true,
      isHost: true,
      isSpectator: false,
      myName: "Alice",
    });
    expect(deriveRoomView(s, "B")).toMatchObject({ mySeat: 1, isHost: false, myName: "Bo" });
    expect(deriveRoomView(s, "ghost")).toMatchObject({
      mySeat: -1,
      seated: false,
      isSpectator: true,
      myName: "Spectator",
    });
  });

  it("standings are empty without a result", () => {
    expect(deriveRoomView(snap(), "A", null).standings).toEqual([]);
  });

  it("sorts standings by place, breaking shared placements by games won", () => {
    const s = snap({
      seats: [seat("A", "Alice", true), seat("B", "Bo"), seat("C", "Cleo")],
    });
    const shared = { label: "9–12th", undefeated: false, flawlessGroup: false, gamesLost: 4 };
    const r = statsOnly({
      A: { place: 9, gamesWon: 3, ...shared },
      B: { place: 1, gamesWon: 12, label: "Champion", undefeated: false, flawlessGroup: false, gamesLost: 2 },
      C: { place: 9, gamesWon: 5, ...shared },
    });
    const names = deriveRoomView(s, "A", r).standings.map((x) => x.seat.name);
    expect(names).toEqual(["Bo", "Cleo", "Alice"]);
  });

  it("seats whose players have no tournament stats are left out", () => {
    const s = snap({ seats: [seat("A", "Alice", true), seat("late", "Latecomer")] });
    const view = deriveRoomView(s, "A", result);
    expect(view.standings.map((x) => x.seat.playerId)).toEqual(
      expect.arrayContaining(["A"]),
    );
    expect(view.standings.some((x) => x.seat.playerId === "late")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runRecordOf
// ---------------------------------------------------------------------------

describe("runRecordOf", () => {
  const { board, strength } = boardAndStrength(100);
  const doneSnap = snap({
    phase: "done",
    draft: { boards: [board, board] } as never,
    strengths: [strength, strength],
  });

  it("assembles my record: sim id, my stats, my roster with assigned heroes", () => {
    const rec = runRecordOf(doneSnap, result, "A", 777)!;
    expect(rec.id).toBe(result.seed);
    expect(rec.date).toBe(777);
    expect(rec.place).toBe(result.ownerStats.A.place);
    expect(rec.label).toBe(`${result.ownerStats.A.label} · vs 1 amigo`);
    expect(rec.overall).toBe(87);
    expect(rec.champion).toBe(result.champion.name);
    expect(rec.config).toEqual({
      format: DEFAULT_MP_CONFIG.format,
      cardMode: DEFAULT_MP_CONFIG.cardMode,
      rerolls: 0,
      heroAlloc: DEFAULT_MP_CONFIG.heroAlloc,
    });
    expect(rec.roster.map((p) => p.heroId)).toEqual([11, 12, 13, 14, 15]);
    expect(rec.roster.map((p) => p.steamId)).toEqual([100, 101, 102, 103, 104]);
  });

  it("pluralizes the label with more drafters", () => {
    const three = snap({
      ...doneSnap,
      seats: [...doneSnap.seats, seat("C", "Cleo")],
    });
    expect(runRecordOf(three, result, "A", 0)!.label).toContain("vs 2 amigos");
  });

  it("returns null for spectators and for seats without tournament stats", () => {
    expect(runRecordOf(doneSnap, result, "ghost", 0)).toBeNull();
    const noStats = snap({ ...doneSnap, seats: [seat("late", "L", true), seat("B", "Bo")] });
    expect(runRecordOf(noStats, result, "late", 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// roomCues
// ---------------------------------------------------------------------------

describe("roomCues", () => {
  const facts = (over: Partial<ClientFacts> = {}): ClientFacts => ({
    snapshot: snap(),
    result: null,
    playerId: "A",
    code: "ROOM1",
    opens: 1,
    phrasesKey: "",
    ...over,
  });
  const kinds = (prev: ClientFacts | null, next: ClientFacts) =>
    roomCues(prev, next, 0).map((c) => c.kind);

  it("fires the stinger only on the lobby → drafting edge", () => {
    const lobby = facts();
    const drafting = facts({ snapshot: snap({ phase: "drafting" }) });
    expect(kinds(lobby, drafting)).toContain("stinger");
    // reloading straight into a running draft is not a start
    expect(kinds(null, drafting)).not.toContain("stinger");
    const assembled = facts({ snapshot: snap({ phase: "assembled" }) });
    expect(kinds(drafting, assembled)).not.toContain("stinger");
  });

  it("syncs phrases when first seated, when re-seated, on reconnect, and on edit — silent otherwise", () => {
    const withPhrases = facts({ phrasesKey: "gg\nez" });
    expect(roomCues(null, withPhrases, 0)).toEqual([
      { kind: "syncPhrases", phrases: ["gg", "ez"] },
    ]);
    // steady state: same facts again → nothing
    expect(kinds(withPhrases, withPhrases)).toEqual([]);
    // reconnect bumps opens
    expect(kinds(withPhrases, { ...withPhrases, opens: 2 })).toEqual(["syncPhrases"]);
    // editing phrases
    expect(kinds(withPhrases, { ...withPhrases, phrasesKey: "gg" })).toEqual(["syncPhrases"]);
    // taking a seat after spectating
    const asGhost = facts({ playerId: "ghost" });
    expect(kinds(null, asGhost)).toEqual([]);
    expect(kinds({ ...withPhrases, playerId: "ghost" }, withPhrases)).toEqual(["syncPhrases"]);
    // no phrases still syncs the empty list (clears a stale server copy)
    expect(roomCues(null, facts(), 0)).toEqual([{ kind: "syncPhrases", phrases: [] }]);
  });

  it("emits my run record while done, keyed per (room, sim); spectators never record", () => {
    const { board, strength } = boardAndStrength(100);
    const done = facts({
      snapshot: snap({
        phase: "done",
        draft: { boards: [board, board] } as never,
        strengths: [strength, strength],
      }),
      result,
    });
    const cues = roomCues(done, done, 123);
    const rec = cues.find((c) => c.kind === "recordRun");
    expect(rec).toBeDefined();
    if (rec?.kind !== "recordRun") throw new Error("unreachable");
    expect(rec.dedupeKey).toBe(runRecordKey("ROOM1", result.seed));
    expect(rec.record.id).toBe(result.seed);
    expect(rec.record.date).toBe(123);
    // idempotent by design: emitted again, the executor dedupes on the key
    expect(kinds(done, done)).toContain("recordRun");
    // still broadcasting → not yet; spectator → never
    expect(kinds(done, facts({ snapshot: snap({ phase: "broadcasting" }), result }))).not.toContain("recordRun");
    expect(kinds(done, { ...done, playerId: "ghost" })).not.toContain("recordRun");
  });
});

// ---------------------------------------------------------------------------
// draftCues — the announcer rule
// ---------------------------------------------------------------------------

describe("draftCues", () => {
  const turn = (roundSeq: number, secsLeft: number | null = null) => ({
    myTurn: true,
    roundSeq,
    turnSeat: 0,
    secsLeft,
  });

  it("announces a turn once, and again for the next round", () => {
    let r = draftCues(NO_DRAFT_CUES, turn(1));
    expect(r.announce).toEqual(["yourTurn"]);
    r = draftCues(r.state, turn(1));
    expect(r.announce).toEqual([]);
    r = draftCues(r.state, turn(2));
    expect(r.announce).toEqual(["yourTurn"]);
  });

  it("a mulligan replacement (same round, same seat) stays silent", () => {
    const first = draftCues(NO_DRAFT_CUES, turn(3));
    expect(first.announce).toEqual(["yourTurn"]);
    // pack swapped, but round+seat unchanged
    expect(draftCues(first.state, turn(3)).announce).toEqual([]);
  });

  it("warns at five seconds exactly once per turn, never at zero or with the timer off", () => {
    let r = draftCues(NO_DRAFT_CUES, turn(1, 20));
    expect(r.announce).toEqual(["yourTurn"]);
    r = draftCues(r.state, turn(1, 5));
    expect(r.announce).toEqual(["fiveSeconds"]);
    r = draftCues(r.state, turn(1, 4));
    expect(r.announce).toEqual([]);
    expect(draftCues(NO_DRAFT_CUES, turn(1, 0)).announce).toEqual(["yourTurn"]);
    expect(draftCues(NO_DRAFT_CUES, turn(1, null)).announce).toEqual(["yourTurn"]);
  });

  it("arriving late with the clock already low says both lines", () => {
    expect(draftCues(NO_DRAFT_CUES, turn(1, 3)).announce).toEqual(["yourTurn", "fiveSeconds"]);
  });

  it("not my turn: nothing to say, state untouched", () => {
    const r = draftCues(NO_DRAFT_CUES, { myTurn: false, roundSeq: 1, turnSeat: 1, secsLeft: 2 });
    expect(r.announce).toEqual([]);
    expect(r.state).toBe(NO_DRAFT_CUES);
  });
});
