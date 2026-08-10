import { describe, expect, it } from "vitest";
import type { Beat } from "../game/beats";
import { mulberry32 } from "../game/rng";
import type { DataBundle, Pack, PackPlayer, Role, SimResult } from "../game/types";
import { legalActions } from "./engine";
import type { ClientMsg } from "./protocol";
import {
  CLEANUP_MS,
  freshRoom,
  migrateRoom,
  needsData,
  nextAlarm,
  roomReducer,
  snapshotOf,
  type RoomCtx,
  type RoomEvent,
  type RoomResult,
  type RoomState,
} from "./room";

// ---------------------------------------------------------------------------
// Synthetic fixtures (same shapes engine.test.ts uses).
// ---------------------------------------------------------------------------

const FULL_ROLES: Role[] = ["safelane", "mid", "offlane", "support", "support"];

function makePlayer(steamId: number, role: Role, ovr = 80): PackPlayer {
  return {
    steamId,
    nickname: `p${steamId}`,
    role,
    ovr,
    impact: 70,
    economy: 70,
    reliability: 70,
    games: 50,
  };
}

function makePack(id: number, roles: Role[] = FULL_ROLES, heroBase = 0): Pack {
  return {
    id: `pk${id}`,
    eventId: "ev1",
    teamId: id,
    teamName: `Team ${id}`,
    tag: `T${id}`,
    logoId: "",
    placement: 1,
    players: roles.map((r, i) => makePlayer(id * 100 + i, r)),
    signatureHeroes: [heroBase + 1, heroBase + 2, heroBase + 3, heroBase + 4, heroBase + 5],
  };
}

function makePool(n = 40): Pack[] {
  return Array.from({ length: n }, (_, i) => makePack(i + 1, FULL_ROLES, (i + 1) * 10));
}

const bundle: DataBundle = {
  events: [],
  packs: [],
  heroes: [],
  playerHeroStats: {},
  squadSynergy: [],
};

const T0 = 1_000_000;

function makeCtx(over: Partial<RoomCtx> = {}): RoomCtx {
  return {
    now: T0,
    random: mulberry32(42),
    data: { pool: makePool(), bundle },
    sim: () => {
      throw new Error("sim not stubbed for this test");
    },
    connectedIds: () => new Set<string>(),
    ...over,
  };
}

const connect = (playerId: string, name: string, prefersSpectator = false): RoomEvent => ({
  type: "connect",
  playerId,
  name,
  prefersSpectator,
});

const msg = (playerId: string, m: ClientMsg, connName = playerId): RoomEvent => ({
  type: "message",
  playerId,
  connName,
  msg: m,
});

/** A tiny host: threads state through the reducer, keeps the last result. */
class TestRoom {
  state: RoomState = freshRoom();
  last!: RoomResult;
  constructor(private over: Partial<RoomCtx> = {}) {}
  send(event: RoomEvent, over: Partial<RoomCtx> = {}): RoomResult {
    this.last = roomReducer(this.state, event, makeCtx({ ...this.over, ...over }));
    this.state = this.last.state;
    return this.last;
  }
}

/** Lobby with host A and drafter B, draft not yet started. */
function lobbyAB(over: Partial<RoomCtx> = {}): TestRoom {
  const room = new TestRoom(over);
  room.send(connect("A", "Alice"));
  room.send(connect("B", "Bo"));
  return room;
}

/** Run a started draft to completion via alarm autopicks. */
function draftToDone(room: TestRoom) {
  for (let guard = 0; room.state.phase === "drafting"; guard++) {
    if (guard > 300) throw new Error("draft did not terminate");
    expect(room.state.turnDeadline).not.toBeNull();
    room.send({ type: "alarm" }, { now: room.state.turnDeadline! });
  }
}

// ---------------------------------------------------------------------------

describe("lobby seating", () => {
  it("seats arrivals in order and makes the first the host", () => {
    const room = lobbyAB();
    expect(room.state.seats.map((s) => [s.playerId, s.name, s.isHost])).toEqual([
      ["A", "Alice", true],
      ["B", "Bo", false],
    ]);
    expect(room.last.changed).toBe(true);
    expect(room.last.conns).toEqual([{ playerId: "B", name: "Bo", spectating: false }]);
  });

  it("keeps a spectator-intent arrival out of the seats", () => {
    const room = new TestRoom();
    room.send(connect("A", "Alice", true));
    expect(room.state.seats).toHaveLength(0);
    expect(room.last.conns).toEqual([{ playerId: "A", name: "Alice", spectating: true }]);
  });

  it("never clobbers a renamed seat on reconnect", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "rename", name: "Zeus" }));
    room.send(connect("A", "Alice")); // reconnect replays the stale query-string name
    expect(room.state.seats[0].name).toBe("Zeus");
    expect(room.last.conns).toEqual([{ playerId: "A", name: "Zeus", spectating: false }]);
  });

  it("disambiguates a duplicate arrival name instead of refusing the seat", () => {
    const room = lobbyAB();
    room.send(connect("C", "Alice"));
    expect(room.state.seats[2].name).toBe("Alice 2");
  });

  it("does not seat new arrivals after the draft starts", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    room.send(connect("C", "Late"));
    expect(room.state.seats).toHaveLength(2);
    expect(room.last.conns).toEqual([{ playerId: "C", name: "Late", spectating: true }]);
  });

  it("vacating via spectate hands hosting to the next drafter", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "spectate" }));
    expect(room.state.seats.map((s) => [s.playerId, s.isHost])).toEqual([["B", true]]);
    expect(room.last.conns).toEqual([{ playerId: "A", spectating: true }]);
  });

  it("rejects takeSeat in a full room", () => {
    const room = new TestRoom();
    for (let i = 0; i < 8; i++) room.send(connect(`P${i}`, `Team ${i}`));
    room.send(connect("X", "Extra", true));
    const res = room.send(msg("X", { t: "takeSeat" }));
    expect(res.reply?.code).toBe("room-full");
    expect(res.changed).toBe(false);
  });
});

describe("kick", () => {
  it("unseats the target, flips their connections to spectator, and notifies them", () => {
    const room = lobbyAB();
    const res = room.send(msg("A", { t: "kick", playerId: "B" }));
    expect(room.state.seats.map((s) => s.playerId)).toEqual(["A"]);
    expect(res.conns).toEqual([{ playerId: "B", spectating: true }]);
    expect(res.notify?.[0]).toMatchObject({ playerId: "B", code: "kicked" });
  });

  it("guards: only the host, never yourself, only the seated", () => {
    const room = lobbyAB();
    expect(room.send(msg("B", { t: "kick", playerId: "A" })).reply?.code).toBe("not-host");
    expect(room.send(msg("A", { t: "kick", playerId: "A" })).reply?.code).toBe("bad-target");
    expect(room.send(msg("A", { t: "kick", playerId: "Z" })).reply?.code).toBe("bad-target");
  });
});

describe("rename and phrases", () => {
  it("rejects the you-tag, empty names, and taken names", () => {
    const room = lobbyAB();
    expect(room.send(msg("B", { t: "rename", name: "Bo (you)" })).reply?.code).toBe("bad-name");
    expect(room.send(msg("B", { t: "rename", name: "   " })).reply?.code).toBe("bad-name");
    expect(room.send(msg("B", { t: "rename", name: "alice" })).reply?.code).toBe("name-taken");
    expect(room.state.seats[1].name).toBe("Bo");
  });

  it("stores sanitized phrases and clears them on an empty list", () => {
    const room = lobbyAB();
    room.send(msg("B", { t: "phrases", phrases: ["  gg   ez  ", ""] }));
    expect(room.state.phrases).toEqual({ B: ["gg ez"] });
    room.send(msg("B", { t: "phrases", phrases: [] }));
    expect(room.state.phrases).toEqual({});
  });
});

describe("configure", () => {
  it("is host-only, lobby-only, and sanitized", () => {
    const room = lobbyAB();
    expect(room.send(msg("B", { t: "configure", config: {} })).reply?.code).toBe("not-host");
    room.send(msg("A", { t: "configure", config: { timerSecs: 99 as never, mulligans: 2 } }));
    expect(room.state.config.timerSecs).toBe(15); // 99 is not a legal setting
    expect(room.state.config.mulligans).toBe(2);
  });
});

describe("start and the draft", () => {
  it("guards host, minimum seats", () => {
    const room = new TestRoom();
    room.send(connect("A", "Alice"));
    expect(room.send(msg("A", { t: "start" })).reply?.code).toBe("need-players");
    room.send(connect("B", "Bo"));
    expect(room.send(msg("B", { t: "start" })).reply?.code).toBe("not-host");
  });

  it("opens the first spread, arms the turn deadline, and stores a draft seed", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    const r = room.state;
    expect(r.phase).toBe("drafting");
    expect(r.draftSeed).not.toBeNull();
    expect(r.engine!.currentPacks.length).toBeGreaterThan(0);
    expect(r.engine!.turnSeat).not.toBeNull();
    expect(r.turnDeadline).toBe(T0 + 15_000);
  });

  it("applies a legal pick and rejects off-turn actions", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    const e = room.state.engine!;
    const turn = e.turnSeat!;
    const other = room.state.seats[turn === 0 ? 1 : 0].playerId;
    const mine = room.state.seats[turn].playerId;
    const pick = legalActions(e, turn).picks[0];

    const bad = room.send(msg(other, { t: "pick", card: pick }));
    expect(bad.reply?.code).toBe("not-your-turn");
    expect(bad.changed).toBe(false);

    const ok = room.send(msg(mine, { t: "pick", card: pick }));
    expect(ok.changed).toBe(true);
    expect(room.state.engine!.actedSeats).toContain(turn);
  });

  it("ignores a stale turn alarm", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    const before = room.state.engine;
    const res = room.send({ type: "alarm" }, { now: room.state.turnDeadline! - 5_000 });
    expect(res.changed).toBe(false);
    expect(room.state.engine).toEqual(before);
  });

  it("autopicks through timeouts all the way to assembled", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    draftToDone(room);
    const r = room.state;
    expect(r.phase).toBe("assembled");
    expect(r.turnDeadline).toBeNull();
    expect(r.strengths).toHaveLength(2);
    expect(r.heroAssignments).toHaveLength(2);
    expect(r.field).toHaveLength(18);
    expect(r.field!.filter((t) => t.ownerId != null)).toHaveLength(2);
  });

  it("replays identically from the same seed: the draft is deterministic", () => {
    const run = () => {
      const room = lobbyAB({ random: mulberry32(7) });
      room.send(msg("A", { t: "start" }), { random: mulberry32(7) });
      draftToDone(room);
      return room.state;
    };
    const a = run();
    const b = run();
    expect(a.draftSeed).toBe(b.draftSeed);
    expect(a.engine!.boards).toEqual(b.engine!.boards);
    expect(a.engine!.deniedShelf).toEqual(b.engine!.deniedShelf);
  });
});

describe("assignHero", () => {
  it("is rejected in auto mode and validated in manual mode", () => {
    const auto = lobbyAB();
    auto.send(msg("A", { t: "start" }));
    draftToDone(auto);
    expect(auto.send(msg("A", { t: "assignHero", steamId: 1, heroId: 1 })).reply?.code).toBe(
      "auto-assignment",
    );

    const room = lobbyAB();
    room.send(msg("A", { t: "configure", config: { heroAlloc: "manual" } }));
    room.send(msg("A", { t: "start" }));
    draftToDone(room);
    expect(room.send(msg("A", { t: "assignHero", steamId: 1, heroId: 1 })).reply?.code).toBe(
      "bad-player",
    );

    const board = room.state.engine!.boards[0];
    const steamId = Object.values(board.slots)[0]!.steamId;
    const heroId = board.heroes[0];
    const before = room.state.field;
    const res = room.send(msg("A", { t: "assignHero", steamId, heroId }));
    expect(res.changed).toBe(true);
    expect(room.state.heroAssignments![0][String(steamId)]).toBe(heroId);
    // same fieldSeed: the field is re-derived, not re-rolled
    expect(room.state.field!.map((t) => t.name)).toEqual(before!.map((t) => t.name));
  });
});

describe("the reveal", () => {
  const BEATS: Beat[] = [
    { kind: "intro", ms: 1000 },
    { kind: "groupRound", upTo: 0, ms: 800 },
    { kind: "taunt", roundIdx: 0, matchIdx: 0, ms: 2800 },
    { kind: "standings", ms: 500 },
  ];
  const RESULT = {
    rounds: [
      { name: "GF", matches: [{ winner: { ownerId: "A" }, loser: { ownerId: "B" } }] },
    ],
  } as unknown as SimResult;
  const sim = () => ({ beats: BEATS, result: RESULT });

  function broadcasting(): TestRoom {
    const room = lobbyAB({ sim });
    room.send(msg("A", { t: "start" }));
    draftToDone(room);
    room.send(msg("A", { t: "play" }));
    return room;
  }

  it("play is host-only and starts the ticker at beat 0", () => {
    const room = lobbyAB({ sim });
    room.send(msg("A", { t: "start" }));
    draftToDone(room);
    expect(room.send(msg("B", { t: "play" })).reply?.code).toBe("not-host");
    room.send(msg("A", { t: "play" }));
    expect(room.state.phase).toBe("broadcasting");
    expect(room.state.beat).toEqual({ idx: 0, playing: true });
    expect(room.state.beatDeadline).toBe(T0 + 1000);
  });

  it("alarm ticks advance beats and land on done", () => {
    const room = broadcasting();
    room.send({ type: "alarm" });
    expect(room.state.beat!.idx).toBe(1);
    expect(room.state.beatDeadline).toBe(T0 + 800);
    room.send({ type: "alarm" });
    room.send({ type: "alarm" });
    expect(room.state.phase).toBe("done");
    expect(room.state.beat).toEqual({ idx: 3, playing: false });
    expect(room.state.beatDeadline).toBeNull();
  });

  it("pause holds the ticker; resume re-arms it; skip jumps to done", () => {
    const room = broadcasting();
    room.send(msg("A", { t: "beat", action: "pause" }));
    expect(room.state.beatDeadline).toBeNull();
    expect(room.send({ type: "alarm" }).changed).toBe(false); // paused: a stray alarm is inert
    room.send(msg("A", { t: "beat", action: "resume" }));
    expect(room.state.beat).toEqual({ idx: 0, playing: true });
    expect(room.state.beatDeadline).toBe(T0 + 1000);
    room.send(msg("A", { t: "beat", action: "skip" }));
    expect(room.state.phase).toBe("done");
  });

  it("reveals a victory phrase only on its taunt beat, never in the raw state", () => {
    const room = broadcasting();
    room.send(msg("A", { t: "phrases", phrases: ["gg"] }), { sim });
    expect(snapshotOf(room.state, sim).taunt).toBeNull(); // intro beat
    room.send({ type: "alarm" });
    room.send({ type: "alarm" }); // now on the taunt beat
    expect(snapshotOf(room.state, sim).taunt).toEqual({ ownerId: "A", phrase: "gg" });
    // The snapshot never carries the phrase store itself.
    expect("phrases" in snapshotOf(room.state, sim)).toBe(false);
  });
});

describe("presence, cleanup, and the alarm slot", () => {
  it("close sweeps seat connected flags from live connections", () => {
    const room = lobbyAB();
    const res = room.send({ type: "close" }, { connectedIds: () => new Set(["A"]) });
    expect(res.changed).toBe(true);
    expect(room.state.seats.map((s) => s.connected)).toEqual([true, false]);
    // nothing moved → nothing to persist
    expect(room.send({ type: "close" }, { connectedIds: () => new Set(["A"]) }).changed).toBe(false);
  });

  it("an alarm in an empty done room purges it", () => {
    const room = lobbyAB();
    room.state.phase = "done";
    expect(room.send({ type: "alarm" }).purge).toBe(true);
    expect(room.send({ type: "alarm" }, { connectedIds: () => new Set(["A"]) }).purge).toBeUndefined();
  });

  it("nextAlarm: one owner per phase", () => {
    const r = freshRoom();
    expect(nextAlarm(r, { now: T0, empty: false })).toBeNull();
    expect(nextAlarm({ ...r, phase: "drafting", turnDeadline: 123 }, { now: T0, empty: false })).toBe(123);
    expect(nextAlarm({ ...r, phase: "drafting" }, { now: T0, empty: false })).toBeNull(); // timer off
    const playing = { ...r, phase: "broadcasting" as const, beat: { idx: 0, playing: true }, beatDeadline: 456 };
    expect(nextAlarm(playing, { now: T0, empty: false })).toBe(456);
    expect(nextAlarm({ ...playing, beat: { idx: 0, playing: false } }, { now: T0, empty: false })).toBeNull();
    expect(nextAlarm({ ...r, phase: "done" }, { now: T0, empty: true })).toBe(T0 + CLEANUP_MS);
    expect(nextAlarm({ ...r, phase: "done" }, { now: T0, empty: false })).toBeNull();
  });

  it("needsData: draft actions and drafting alarms, nothing else", () => {
    const r = freshRoom();
    expect(needsData(r, msg("A", { t: "start" }))).toBe(true);
    expect(needsData(r, msg("A", { t: "pick", card: { kind: "hero", heroId: 1 } }))).toBe(true);
    expect(needsData(r, msg("A", { t: "rename", name: "x" }))).toBe(false);
    expect(needsData(r, { type: "alarm" })).toBe(false);
    expect(needsData({ ...r, phase: "drafting" }, { type: "alarm" })).toBe(true);
    expect(needsData(r, connect("A", "Alice"))).toBe(false);
  });
});

describe("migration", () => {
  it("defaults the reducer-era fields and revives a mid-reveal deadline", () => {
    const legacy = { ...freshRoom() } as Partial<RoomState> as RoomState;
    delete (legacy as Partial<RoomState>).draftSeed;
    delete (legacy as Partial<RoomState>).beatDeadline;
    const m = migrateRoom(legacy, T0);
    expect(m.draftSeed).toBeNull();
    expect(m.beatDeadline).toBeNull();

    const live = { ...m, phase: "broadcasting" as const, beat: { idx: 3, playing: true }, beatDeadline: null };
    expect(migrateRoom(live, T0).beatDeadline).toBe(T0 + 1500);
  });

  it("reducer never mutates its input", () => {
    const room = lobbyAB();
    const before = structuredClone(room.state);
    roomReducer(room.state, msg("A", { t: "rename", name: "Mutant" }), makeCtx());
    expect(room.state).toEqual(before);
  });
});
