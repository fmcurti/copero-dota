import { describe, expect, it } from "vitest";
import {
  LISTING_TTL_MS,
  MAX_LISTINGS,
  MAX_PROBES_PER_TICK,
  PROBE_AFTER_MS,
  isFresh,
  isJoinable,
  isWatchable,
  listingKey,
  liveGames,
  openLobbies,
  overflowCodes,
  probeCodes,
  staleCodes,
  type RoomListing,
} from "./directory";

const NOW = 1_700_000_000_000;

function listing(over: Partial<RoomListing> = {}): RoomListing {
  return {
    code: "AAAAA",
    visibility: "public",
    phase: "lobby",
    seats: 2,
    maxSeats: 8,
    host: "Host",
    teams: ["Host", "Other"],
    watchers: 0,
    rev: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("which list an entry lands on", () => {
  it("puts an open public lobby on the home page and nowhere else", () => {
    const l = listing();
    expect(isJoinable(l)).toBe(true);
    expect(isWatchable(l)).toBe(false);
  });

  it("never shows a spectatable room while it is still filling up", () => {
    const l = listing({ visibility: "spectatable" });
    expect(isJoinable(l)).toBe(false);
    expect(isWatchable(l)).toBe(false);
  });

  it("moves both public and spectatable rooms to the watch list once they start", () => {
    for (const visibility of ["public", "spectatable"] as const) {
      for (const phase of ["drafting", "assembled", "broadcasting"] as const) {
        const l = listing({ visibility, phase });
        expect(isWatchable(l)).toBe(true);
        expect(isJoinable(l)).toBe(false);
      }
    }
  });

  it("drops a full public lobby from the joinable list", () => {
    expect(isJoinable(listing({ seats: 8, maxSeats: 8 }))).toBe(false);
    expect(isJoinable(listing({ seats: 7, maxSeats: 8 }))).toBe(true);
  });

  it("shows a finished room nowhere", () => {
    const l = listing({ phase: "done" });
    expect(isJoinable(l)).toBe(false);
    expect(isWatchable(l)).toBe(false);
  });
});

describe("freshness", () => {
  it("rots exactly at the TTL", () => {
    const l = listing();
    expect(isFresh(l, NOW + LISTING_TTL_MS - 1)).toBe(true);
    expect(isFresh(l, NOW + LISTING_TTL_MS)).toBe(false);
  });

  it("hides rotted entries from both lists even when they otherwise qualify", () => {
    const old = listing({ code: "OLD", updatedAt: NOW - LISTING_TTL_MS });
    const live = listing({ code: "NEW" });
    expect(openLobbies([old, live], NOW).map((l) => l.code)).toEqual(["NEW"]);
    expect(staleCodes([old, live], NOW)).toEqual(["OLD"]);
  });
});

describe("sorting", () => {
  it("orders open lobbies by fullest first, then newest, then code", () => {
    const rooms = [
      listing({ code: "CCCCC", seats: 2 }),
      listing({ code: "AAAAA", seats: 5 }),
      listing({ code: "BBBBB", seats: 2, rev: NOW + 1 }),
    ];
    expect(openLobbies(rooms, NOW).map((l) => l.code)).toEqual(["AAAAA", "BBBBB", "CCCCC"]);
  });

  it("orders live games by phase, then by crowd", () => {
    const rooms = [
      listing({ code: "BCAST", phase: "broadcasting" }),
      listing({ code: "DRAFT", phase: "drafting" }),
      listing({ code: "ASSEM", phase: "assembled", watchers: 9 }),
    ];
    expect(liveGames(rooms, NOW).map((l) => l.code)).toEqual(["DRAFT", "ASSEM", "BCAST"]);
  });

  it("is a total order — equal rows fall back to the code", () => {
    const rooms = [listing({ code: "ZZZZZ" }), listing({ code: "AAAAA" })];
    expect(openLobbies(rooms, NOW).map((l) => l.code)).toEqual(["AAAAA", "ZZZZZ"]);
  });
});

describe("directory maintenance", () => {
  it("probes the quietest entries first and caps the fan-out", () => {
    const rooms = Array.from({ length: MAX_PROBES_PER_TICK + 5 }, (_, i) =>
      listing({ code: `R${i}`, updatedAt: NOW - PROBE_AFTER_MS - i }),
    );
    const codes = probeCodes(rooms, NOW);
    expect(codes).toHaveLength(MAX_PROBES_PER_TICK);
    // Oldest (largest i) first.
    expect(codes[0]).toBe(`R${rooms.length - 1}`);
  });

  it("leaves recently confirmed entries alone", () => {
    const fresh = listing({ code: "FRESH", updatedAt: NOW - PROBE_AFTER_MS + 1 });
    const quiet = listing({ code: "QUIET", updatedAt: NOW - PROBE_AFTER_MS });
    expect(probeCodes([fresh, quiet], NOW)).toEqual(["QUIET"]);
  });

  it("never probes an entry that is already rotted — staleCodes takes it", () => {
    const dead = listing({ code: "DEAD", updatedAt: NOW - LISTING_TTL_MS });
    expect(probeCodes([dead], NOW)).toEqual([]);
    expect(staleCodes([dead], NOW)).toEqual(["DEAD"]);
  });

  it("evicts the least recently confirmed when over cap", () => {
    const rooms = Array.from({ length: MAX_LISTINGS + 3 }, (_, i) =>
      listing({ code: `R${i}`, updatedAt: NOW - i }),
    );
    const victims = overflowCodes(rooms);
    expect(victims).toHaveLength(3);
    expect(victims).toEqual([`R${MAX_LISTINGS + 2}`, `R${MAX_LISTINGS + 1}`, `R${MAX_LISTINGS}`]);
    expect(overflowCodes(rooms.slice(0, MAX_LISTINGS))).toEqual([]);
  });
});

describe("listingKey", () => {
  it("ignores the clocks so an unchanged row costs no write", () => {
    expect(listingKey(listing({ rev: 1 }))).toBe(listingKey(listing({ rev: 2 })));
  });

  it("notices anything a viewer can actually see", () => {
    const base = listing();
    for (const change of [
      { phase: "drafting" as const },
      { seats: 3 },
      { watchers: 1 },
      { teams: ["Host", "Someone else"] },
      { visibility: "spectatable" as const },
      { host: "Other" },
    ]) {
      expect(listingKey({ ...base, ...change })).not.toBe(listingKey(base));
    }
  });

  it("has a distinct key for a retraction", () => {
    expect(listingKey(null)).not.toBe(listingKey(listing()));
  });
});
