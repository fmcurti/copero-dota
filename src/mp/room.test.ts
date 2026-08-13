import { describe, expect, it } from "vitest";
import type { Beat } from "../game/beats";
import { mulberry32 } from "../game/rng";
import type { DataBundle, Pack, PackPlayer, Role, SimResult } from "../game/types";
import { legalActions } from "./engine";
import { CHAT_LOG_CAP, MAX_CHAT_LEN, type ClientMsg } from "./protocol";
import {
  RANKED_ALL_CONNECTED_MS,
  RANKED_CONFIG,
  RANKED_START_GRACE_MS,
} from "../ranked/protocol";
import {
  CLEANUP_MS,
  freshRoom,
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

describe("chat", () => {
  const noSim = () => {
    throw new Error("sim not needed in lobby");
  };

  it("appends a seated player's message and projects it into the snapshot", () => {
    const room = lobbyAB();
    const res = room.send(msg("B", { t: "chat", text: "  hola   copero  " }));
    expect(res.changed).toBe(true);
    expect(room.state.chat).toEqual([
      { seq: 1, playerId: "B", name: "Bo", text: "hola copero", at: T0 },
    ]);
    expect(snapshotOf(room.state, noSim).chat).toEqual(room.state.chat);
  });

  it("rejects unseated senders and empty messages", () => {
    const room = lobbyAB();
    expect(room.send(msg("Z", { t: "chat", text: "hi" })).reply?.code).toBe("no-seat");
    expect(room.send(msg("A", { t: "chat", text: "   " })).reply?.code).toBe("empty-chat");
    expect(room.state.chat).toEqual([]);
  });

  it("stores over-long messages truncated", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "chat", text: "x".repeat(MAX_CHAT_LEN + 50) }));
    expect(room.state.chat[0].text).toHaveLength(MAX_CHAT_LEN);
  });

  it("caps the log while seq stays monotonic across the rotation", () => {
    const room = lobbyAB();
    for (let i = 0; i < CHAT_LOG_CAP + 5; i++) {
      // Spaced out so the flood guard never trips.
      const res = room.send(msg("A", { t: "chat", text: `m${i}` }), { now: T0 + i * 3000 });
      expect(res.reply).toBeUndefined();
    }
    expect(room.state.chat).toHaveLength(CHAT_LOG_CAP);
    expect(room.state.chat[0].seq).toBe(6);
    expect(room.state.chat.at(-1)!.seq).toBe(CHAT_LOG_CAP + 5);
  });

  it("flood-guards a sender's sixth message inside ten seconds", () => {
    const room = lobbyAB();
    for (let i = 0; i < 5; i++) {
      expect(room.send(msg("A", { t: "chat", text: `m${i}` })).reply).toBeUndefined();
    }
    expect(room.send(msg("A", { t: "chat", text: "spam" })).reply?.code).toBe("chat-flood");
    // Another seat is not throttled by A's flood…
    expect(room.send(msg("B", { t: "chat", text: "hi" })).reply).toBeUndefined();
    // …and A recovers once the window slides past.
    expect(
      room.send(msg("A", { t: "chat", text: "back" }), { now: T0 + 11_000 }).reply,
    ).toBeUndefined();
  });

  it("works mid-draft and never demands the data bundle", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "start" }));
    expect(needsData(room.state, msg("A", { t: "chat", text: "gl" }))).toBe(false);
    const res = room.send(msg("A", { t: "chat", text: "gl" }), { data: null });
    expect(res.changed).toBe(true);
    expect(room.state.chat.at(-1)!.text).toBe("gl");
  });

  it("keeps attribution through kicks and renames", () => {
    const room = lobbyAB();
    room.send(msg("B", { t: "chat", text: "see ya" }));
    room.send(msg("A", { t: "chat", text: "bye" }));
    room.send(msg("A", { t: "kick", playerId: "B" }));
    room.send(msg("A", { t: "rename", name: "Zeus" }));
    room.send(msg("A", { t: "chat", text: "alone now" }));
    // Old entries keep the name they were sent under — kicked or renamed.
    expect(room.state.chat.map((m) => m.name)).toEqual(["Bo", "Alice", "Zeus"]);
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

    const bad = room.send(msg(other, { t: "draft", action: { type: "pick", card: pick } }));
    expect(bad.reply?.code).toBe("not-your-turn");
    expect(bad.changed).toBe(false);

    const ok = room.send(msg(mine, { t: "draft", action: { type: "pick", card: pick } }));
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

describe("turbo rooms", () => {
  /** Lobby with host A and drafter B, turbo mode configured. */
  function turboLobby(over: Partial<RoomCtx> = {}): TestRoom {
    const room = lobbyAB(over);
    room.send(msg("A", { t: "configure", config: { draftMode: "turbo" } }));
    return room;
  }

  /** Run a turbo draft to completion via per-seat alarm autopicks. */
  function turboToDone(room: TestRoom) {
    for (let guard = 0; room.state.phase === "drafting"; guard++) {
      if (guard > 300) throw new Error("draft did not terminate");
      const armed = room.state.turnDeadlines!.filter((d): d is number => d != null);
      expect(armed.length).toBeGreaterThan(0);
      room.send({ type: "alarm" }, { now: Math.min(...armed) });
    }
  }

  it("sanitizes draftMode and locks it into the engine on start", () => {
    const room = lobbyAB();
    room.send(msg("A", { t: "configure", config: { draftMode: "hyper" as never } }));
    expect(room.state.config.draftMode).toBe("classic");
    room.send(msg("A", { t: "configure", config: { draftMode: "turbo" } }));
    room.send(msg("A", { t: "start" }));
    expect(room.state.engine!.mode).toBe("turbo");
  });

  it("start deals a wave: every seat holds a pack, per-seat clocks armed", () => {
    const room = turboLobby();
    room.send(msg("A", { t: "start" }));
    const r = room.state;
    expect(r.engine!.currentPacks).toHaveLength(2);
    expect(r.engine!.turnSeat).toBeNull();
    expect(r.turnDeadline).toBeNull();
    expect(r.turnDeadlines).toEqual([T0 + 15_000, T0 + 15_000]);
    const snap = snapshotOf(r, () => {
      throw new Error("sim not needed while drafting");
    });
    expect(snap.draft!.mode).toBe("turbo");
    expect(snap.draft!.turnDeadlines).toEqual([T0 + 15_000, T0 + 15_000]);
  });

  it("seats act simultaneously; a clock survives only while the same pack is in hand", () => {
    const room = turboLobby();
    room.send(msg("A", { t: "start" }));
    // B picks first — there is no turn order to violate
    const pickB = legalActions(room.state.engine!, 1).picks[0];
    const res = room.send(
      msg("B", { t: "draft", action: { type: "pick", card: pickB } }),
      { now: T0 + 3_000 },
    );
    expect(res.reply).toBeUndefined();
    // B's leftovers queue behind A's own pack: A's clock is untouched
    expect(room.state.turnDeadlines![0]).toBe(T0 + 15_000);
    // B holds nothing now → no clock
    expect(room.state.turnDeadlines![1]).toBeNull();
    // A picks; A's leftovers reach B and B's clock re-arms; A moves on to
    // B's leftovers, a new pack in hand → fresh clock too
    const pickA = legalActions(room.state.engine!, 0).picks[0];
    room.send(msg("A", { t: "draft", action: { type: "pick", card: pickA } }), { now: T0 + 5_000 });
    expect(room.state.turnDeadlines).toEqual([T0 + 20_000, T0 + 20_000]);
  });

  it("the alarm autopicks only the seats whose clocks ran out", () => {
    const room = turboLobby();
    room.send(msg("A", { t: "start" }));
    const pickB = legalActions(room.state.engine!, 1).picks[0];
    room.send(msg("B", { t: "draft", action: { type: "pick", card: pickB } }), { now: T0 + 3_000 });
    const before = room.state.engine!;
    const res = room.send({ type: "alarm" }, { now: T0 + 15_000 });
    expect(res.changed).toBe(true);
    // A was autopicked: its own pack moved on to B, whose clock re-armed
    expect(room.state.engine!.takenSteamIds.length + roomHeroes(room)).toBeGreaterThan(
      before.takenSteamIds.length + beforeHeroes(before),
    );
    expect(room.state.turnDeadlines![1]).toBe(T0 + 30_000);
    // a premature alarm changes nothing
    expect(room.send({ type: "alarm" }, { now: T0 + 16_000 }).changed).toBe(false);
  });

  it("turbo timeouts run the draft all the way to assembled", () => {
    const room = turboLobby();
    room.send(msg("A", { t: "start" }));
    turboToDone(room);
    const r = room.state;
    expect(r.phase).toBe("assembled");
    expect(r.turnDeadlines).toBeNull();
    expect(r.strengths).toHaveLength(2);
    expect(r.field).toHaveLength(18);
  });

  it("replays identically from the same seed", () => {
    const run = () => {
      const room = turboLobby({ random: mulberry32(7) });
      room.send(msg("A", { t: "start" }), { random: mulberry32(7) });
      turboToDone(room);
      return room.state;
    };
    const a = run();
    const b = run();
    expect(a.draftSeed).toBe(b.draftSeed);
    expect(a.engine!.boards).toEqual(b.engine!.boards);
  });

  it("nextAlarm is the earliest armed seat clock", () => {
    const r = { ...freshRoom(), phase: "drafting" as const, turnDeadlines: [500, null, 300] };
    expect(nextAlarm(r, { now: T0, empty: false })).toBe(300);
    expect(
      nextAlarm({ ...r, turnDeadlines: [null, null, null] }, { now: T0, empty: false }),
    ).toBeNull();
  });

});

/** Total heroes drafted across all boards — progress metric for alarm tests. */
function beforeHeroes(e: { boards: { heroes: number[] }[] }): number {
  return e.boards.reduce((sum, b) => sum + b.heroes.length, 0);
}
function roomHeroes(room: TestRoom): number {
  return beforeHeroes(room.state.engine!);
}

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
    expect(
      needsData(
        r,
        msg("A", { t: "draft", action: { type: "pick", card: { kind: "hero", heroId: 1 } } }),
      ),
    ).toBe(true);
    expect(needsData(r, msg("A", { t: "rename", name: "x" }))).toBe(false);
    expect(needsData(r, { type: "alarm" })).toBe(false);
    expect(needsData({ ...r, phase: "drafting" }, { type: "alarm" })).toBe(true);
    expect(needsData(r, connect("A", "Alice"))).toBe(false);
  });
});

describe("reducer purity", () => {
  it("never mutates its input", () => {
    const room = lobbyAB();
    const before = structuredClone(room.state);
    roomReducer(room.state, msg("A", { t: "rename", name: "Mutant" }), makeCtx());
    expect(room.state).toEqual(before);
  });
});

describe("ranked rooms", () => {
  const ROSTER = [
    { playerId: "u1", name: "Alpha" },
    { playerId: "u2", name: "Bravo" },
    { playerId: "u3", name: "Cobra" },
    { playerId: "u4", name: "Delta" },
  ];
  const BEATS: Beat[] = [
    { kind: "intro", ms: 1000 },
    { kind: "standings", ms: 500 },
  ];
  const sim = () => ({ beats: BEATS, result: { rounds: [] } as unknown as SimResult });

  function rankedRoom(over: Partial<RoomCtx> = {}): TestRoom {
    const room = new TestRoom(over);
    room.send({ type: "rankedInit", roster: ROSTER, config: RANKED_CONFIG });
    return room;
  }

  it("init seats the roster unconnected, hostless, and arms the auto-start clock", () => {
    const room = rankedRoom();
    expect(room.state.seats.map((s) => [s.playerId, s.name, s.connected])).toEqual([
      ["u1", "Alpha", false],
      ["u2", "Bravo", false],
      ["u3", "Cobra", false],
      ["u4", "Delta", false],
    ]);
    // Nobody is host: every host power dies on the ordinary not-host check.
    expect(room.state.seats.some((s) => s.isHost)).toBe(false);
    expect(room.state.config.cardMode).toBe("event");
    expect(room.state.config.visibility).toBe("spectatable");
    expect(room.state.ranked).toEqual({ startAt: T0 + RANKED_START_GRACE_MS, playAt: null });
    expect(nextAlarm(room.state, { now: T0, empty: false })).toBe(T0 + RANKED_START_GRACE_MS);
    expect(needsData(room.state, { type: "alarm" })).toBe(true); // the alarm deals spreads
  });

  it("init refuses short rosters and rooms already in use", () => {
    const fresh = new TestRoom();
    const short = fresh.send({
      type: "rankedInit",
      roster: ROSTER.slice(0, 3),
      config: RANKED_CONFIG,
    });
    expect(short.reply?.code).toBe("bad-init");
    expect(fresh.state.seats).toHaveLength(0);

    const used = rankedRoom();
    expect(
      used.send({ type: "rankedInit", roster: ROSTER, config: RANKED_CONFIG }).reply?.code,
    ).toBe("bad-init");
  });

  it("locks host powers and seat churn, but not renames or chat", () => {
    const room = rankedRoom();
    room.send(connect("u1", "Alpha"));
    // Host powers die on the ordinary not-host check — no seat is host.
    const hostPowers: ClientMsg[] = [
      { t: "configure", config: {} },
      { t: "kick", playerId: "u2" },
      { t: "start" },
      { t: "play" },
      { t: "beat", action: "skip" },
    ];
    for (const m of hostPowers) {
      expect(room.send(msg("u1", m)).reply?.code).toBe("not-host");
    }
    // Seat churn is refused outright.
    for (const m of [{ t: "spectate" }, { t: "takeSeat" }] as ClientMsg[]) {
      expect(room.send(msg("u1", m)).reply?.code).toBe("ranked-locked");
    }
    room.send(msg("u1", { t: "rename", name: "Los Pibes" }));
    expect(room.state.seats[0].name).toBe("Los Pibes");
    room.send(msg("u1", { t: "chat", text: "hola" }));
    expect(room.state.chat).toHaveLength(1);
  });

  it("never unseats a ranked player, even on a spectator-flagged reconnect", () => {
    const room = rankedRoom();
    room.send(connect("u1", "Alpha", true));
    expect(room.state.seats).toHaveLength(4);
    expect(room.last.conns).toEqual([{ playerId: "u1", name: "Alpha", spectating: false }]);
  });

  it("keeps non-roster visitors as spectators, even in the lobby", () => {
    const room = rankedRoom();
    room.send(connect("x", "Rando"));
    expect(room.state.seats).toHaveLength(4);
    expect(room.last.conns).toEqual([{ playerId: "x", name: "Rando", spectating: true }]);
  });

  it("shrinks the lobby wait once the whole roster is connected", () => {
    const room = rankedRoom();
    room.send(connect("u1", "Alpha"));
    room.send(connect("u2", "Bravo"));
    room.send(connect("u3", "Cobra"));
    expect(room.state.ranked!.startAt).toBe(T0 + RANKED_START_GRACE_MS);
    room.send(connect("u4", "Delta"));
    expect(room.state.ranked!.startAt).toBe(T0 + RANKED_ALL_CONNECTED_MS);
  });

  it("auto-starts at the deadline, auto-plays after assembly", () => {
    const room = rankedRoom({ sim });
    for (const p of ROSTER) room.send(connect(p.playerId, p.name));
    const startAt = room.state.ranked!.startAt!;
    expect(room.send({ type: "alarm" }, { now: startAt - 5000 }).changed).toBe(false); // stale
    room.send({ type: "alarm" }, { now: startAt });
    expect(room.state.phase).toBe("drafting");
    expect(room.state.ranked!.startAt).toBeNull();

    draftToDone(room);
    expect(room.state.phase).toBe("assembled");
    const playAt = room.state.ranked!.playAt!;
    expect(nextAlarm(room.state, { now: playAt - 1, empty: false })).toBe(playAt);
    expect(room.send({ type: "alarm" }, { now: playAt - 5000 }).changed).toBe(false); // stale
    room.send({ type: "alarm" }, { now: playAt });
    expect(room.state.phase).toBe("broadcasting");
    expect(room.state.ranked!.playAt).toBeNull();
    expect(room.state.beat).toEqual({ idx: 0, playing: true });
  });

  it("snapshots carry the ranked clock; casual rooms carry null", () => {
    const room = rankedRoom();
    expect(snapshotOf(room.state, sim).ranked).toEqual({
      startAt: T0 + RANKED_START_GRACE_MS,
      playAt: null,
    });
    expect(snapshotOf(freshRoom(), sim).ranked).toBeNull();
  });
});
