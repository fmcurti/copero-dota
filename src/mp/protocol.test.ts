import { describe, expect, it } from "vitest";
import {
  DEFAULT_MP_CONFIG,
  NAME_MAX,
  hasYouTag,
  parseClientMsg,
  parseServerMsg,
  sanitizeName,
} from "./protocol";

describe("team name sanitising", () => {
  it("leaves ordinary names alone", () => {
    expect(sanitizeName("El Copero")).toBe("El Copero");
    expect(hasYouTag("El Copero")).toBe(false);
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeName("  La   Grieta  ")).toBe("La Grieta");
  });

  it("caps length", () => {
    expect(sanitizeName("x".repeat(80))).toHaveLength(NAME_MAX);
  });

  it("rejects the (you) marker in any casing or padding", () => {
    for (const raw of ["(you)", "(YOU)", "(You)", "( you )", "Chan (you)", "a(YoU)b"]) {
      expect(hasYouTag(raw)).toBe(true);
    }
  });

  it("does not flag names that merely contain the word you", () => {
    for (const raw of ["you", "Yousuf", "(your team)", "you)", "(you"]) {
      expect(hasYouTag(raw)).toBe(false);
    }
  });

  it("strips the marker rather than keeping a fake self-label", () => {
    expect(sanitizeName("Chan (you)")).toBe("Chan");
    expect(sanitizeName("(you) Chan")).toBe("Chan");
    expect(sanitizeName("Pichula (YOU) FC")).toBe("Pichula FC");
  });

  it("collapses to empty when the name was only the marker", () => {
    expect(sanitizeName("(you)")).toBe("");
    expect(sanitizeName("  ( You ) ")).toBe("");
  });

  it("is idempotent", () => {
    const once = sanitizeName("Chan (you) (you)");
    expect(sanitizeName(once)).toBe(once);
  });
});

describe("client message parsing", () => {
  it("accepts and normalizes every message family", () => {
    expect(parseClientMsg({ t: "configure", config: { timerSecs: 25, visibility: "public", ignored: true } })).toEqual({
      t: "configure",
      config: { timerSecs: 25, visibility: "public" },
    });
    expect(parseClientMsg({ t: "configure", config: { draftMode: "turbo" } })).toEqual({
      t: "configure",
      config: { draftMode: "turbo" },
    });
    expect(parseClientMsg({ t: "rename", name: "Chan" })).toEqual({ t: "rename", name: "Chan" });
    expect(parseClientMsg({ t: "phrases", phrases: ["gg", "ez"] })).toEqual({
      t: "phrases",
      phrases: ["gg", "ez"],
    });
    for (const t of ["spectate", "takeSeat", "start", "play"] as const) {
      expect(parseClientMsg({ t })).toEqual({ t });
    }
    expect(parseClientMsg({ t: "kick", playerId: "p2" })).toEqual({ t: "kick", playerId: "p2" });
    expect(
      parseClientMsg({
        t: "draft",
        action: { type: "pick", card: { kind: "player", steamId: 123 } },
      }),
    ).toEqual({ t: "draft", action: { type: "pick", card: { kind: "player", steamId: 123 } } });
    expect(parseClientMsg({ t: "draft", action: { type: "mulligan" } })).toEqual({
      t: "draft",
      action: { type: "mulligan" },
    });
    expect(parseClientMsg({ t: "assignHero", steamId: 123, heroId: 456 })).toEqual({
      t: "assignHero",
      steamId: 123,
      heroId: 456,
    });
    expect(parseClientMsg({ t: "beat", action: "skip" })).toEqual({ t: "beat", action: "skip" });
  });

  it("rejects malformed and unknown payloads", () => {
    for (const value of [
      null,
      [],
      {},
      { t: "wat" },
      { t: "rename", name: 42 },
      { t: "phrases", phrases: ["gg", 42] },
      { t: "configure", config: { timerSecs: 10 } },
      { t: "configure", config: { draftMode: "hyper" } },
      { t: "draft", action: { type: "pick" } },
      { t: "draft", action: { type: "deny", card: { kind: "hero", heroId: -1 } } },
      { t: "assignHero", steamId: 1, heroId: 1.5 },
      { t: "beat", action: "rewind" },
    ]) {
      expect(parseClientMsg(value)).toBeNull();
    }
  });
});

describe("server message parsing", () => {
  const snapshot = {
    phase: "lobby",
    config: DEFAULT_MP_CONFIG,
    seats: [{ playerId: "p1", name: "Alpha", connected: true, isHost: true }],
    draft: null,
    strengths: null,
    heroAssignments: null,
    field: null,
    simSeed: null,
    beat: null,
  };

  it("accepts Snapshot and error frames", () => {
    expect(parseServerMsg({ t: "snapshot", room: snapshot })).toEqual({
      t: "snapshot",
      room: snapshot,
    });
    expect(parseServerMsg({ t: "error", code: "room-full", msg: "Room is full." })).toEqual({
      t: "error",
      code: "room-full",
      msg: "Room is full.",
    });
    expect(parseServerMsg({ t: "error", code: "gone", msg: "Gone.", fatal: true })).toEqual({
      t: "error",
      code: "gone",
      msg: "Gone.",
      fatal: true,
    });
  });

  it("accepts structurally valid nested snapshot data", () => {
    const player = {
      steamId: 1,
      nickname: "Carry",
      role: "safelane",
      ovr: 90,
      impact: 91,
      economy: 89,
      reliability: 88,
      games: 20,
      team: "Alpha",
      eventId: "event-1",
    };
    const nested = {
      ...snapshot,
      phase: "assembled",
      draft: {
        mode: "classic",
        packSeq: 1,
        roundSeq: 1,
        openerSeat: 0,
        turnSeat: null,
        turnDeadline: null,
        turnDeadlines: null,
        currentPacks: [
          {
            id: "pack-1",
            teamName: "Alpha",
            eventId: "event-1",
            placement: 1,
            players: [player],
            heroes: [1],
          },
        ],
        packDealtTo: [],
        packPassCount: [],
        boards: [
          {
            slots: {
              safelane: player,
              mid: null,
              offlane: null,
              support1: null,
              support2: null,
            },
            heroes: [1],
          },
        ],
        takenSteamIds: [1],
        deniedShelf: [{ card: { kind: "hero", heroId: 2 }, bySeat: 0, packSeq: 1 }],
        mulligansLeft: [0],
        deniesLeft: [0],
      },
      strengths: [
        {
          overall: 90,
          base: 89,
          heroBonus: 1,
          chemBonus: 0,
          assignment: [{ heroId: 1, games: 20 }],
          chemEdges: [{ i: 0, j: 1, games: 10, bonus: 0.5 }],
          chemTop: [{ names: ["Carry"], games: 20, bonus: 0.5 }],
        },
      ],
      heroAssignments: [{ "1": 1 }],
      field: Array.from({ length: 18 }, (_, i) => ({
        id: `team-${i}`,
        name: `Team ${i}`,
        strength: 80 + i,
        isUser: false,
        ownerId: i === 0 ? "p1" : null,
        ...(i === 0 ? { luck: { chance: 0.05, label: "Lucky" } } : {}),
      })),
      simSeed: 123,
    };

    expect(parseServerMsg({ t: "snapshot", room: nested })).toEqual({
      t: "snapshot",
      room: nested,
    });
  });

  it("rejects malformed server frames before they reach the Room renderer", () => {
    for (const value of [
      null,
      { t: "wat" },
      { t: "error", code: 42, msg: "bad" },
      { t: "snapshot", room: null },
      { t: "snapshot", room: { ...snapshot, phase: "unknown" } },
      { t: "snapshot", room: { ...snapshot, config: {} } },
      { t: "snapshot", room: { ...snapshot, seats: [{ playerId: "p1" }] } },
      { t: "snapshot", room: { ...snapshot, draft: {} } },
      { t: "snapshot", room: { ...snapshot, strengths: [{}] } },
      { t: "snapshot", room: { ...snapshot, heroAssignments: [{ "1": "bad" }] } },
      { t: "snapshot", room: { ...snapshot, field: [{}] } },
      { t: "snapshot", room: { ...snapshot, beat: { idx: -1, playing: true } } },
    ]) {
      expect(parseServerMsg(value)).toBeNull();
    }
  });
});
