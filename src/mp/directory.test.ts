import { describe, expect, it } from "vitest";
import { directoryView, roomDirectory, type RoomListing } from "./directory";
import type { Seat } from "./protocol";

const NOW = 1_700_000_000_000;

const seat = (playerId: string, name: string, isHost = false): Seat => ({
  playerId,
  name,
  connected: true,
  isHost,
});

function room(over: Partial<Parameters<typeof roomDirectory>[0]> = {}) {
  return {
    code: "AAAAA",
    visibility: "public" as const,
    phase: "lobby" as const,
    seats: [seat("a", "Alpha", true), seat("b", "Bravo")],
    connectedPlayerIds: ["a", "b"],
    now: NOW,
    ...over,
  };
}

function listing(over: Partial<RoomListing> = {}): RoomListing {
  return {
    code: "AAAAA",
    visibility: "public",
    phase: "lobby",
    seats: 2,
    maxSeats: 8,
    host: "Alpha",
    teams: ["Alpha", "Bravo"],
    watchers: 0,
    rev: NOW,
    updatedAt: NOW,
    ...over,
  };
}

describe("Room publication", () => {
  it("never exposes private, finished, empty, or spectatable-lobby Rooms", () => {
    expect(roomDirectory(room({ visibility: "private" }), null).entry).toBeNull();
    expect(roomDirectory(room({ phase: "done" }), null).entry).toBeNull();
    expect(roomDirectory(room({ connectedPlayerIds: [] }), null).entry).toBeNull();
    expect(roomDirectory(room({ visibility: "spectatable" }), null).entry).toBeNull();
  });

  it("projects a public Room and counts unique unseated visitors", () => {
    const result = roomDirectory(
      room({ connectedPlayerIds: ["a", "a", "b", "watcher-1", "watcher-1", "watcher-2"] }),
      null,
    );
    expect(result.entry).toEqual({
      code: "AAAAA",
      visibility: "public",
      phase: "lobby",
      seats: 2,
      maxSeats: 8,
      host: "Alpha",
      teams: ["Alpha", "Bravo"],
      watchers: 2,
      rev: NOW,
    });
    expect(result.publication).toEqual(result.entry);
  });

  it("exposes a spectatable Room only after its Draft starts", () => {
    const result = roomDirectory(room({ visibility: "spectatable", phase: "drafting" }), null);
    expect(result.entry).toMatchObject({ visibility: "spectatable", phase: "drafting" });
  });

  it("suppresses unchanged publications, touches visible Rooms, and retracts once", () => {
    const first = roomDirectory(room(), null);
    const unchanged = roomDirectory(room({ now: NOW + 60_000 }), first.state);
    expect(unchanged.publication).toBeUndefined();
    expect(unchanged.state).toBe(first.state);

    const touched = roomDirectory(room({ now: NOW + 6 * 60_000 }), first.state);
    expect(touched.publication).toEqual(touched.entry);

    const hidden = roomDirectory(room({ visibility: "private", now: NOW + 1 }), first.state);
    expect(hidden.publication).toBeNull();
    const stillHidden = roomDirectory(room({ visibility: "private", now: NOW + 2 }), hidden.state);
    expect(stillHidden.publication).toBeUndefined();
  });

  it("publishes immediately when a visible fact changes", () => {
    const first = roomDirectory(room(), null);
    const changed = roomDirectory(
      room({ seats: [seat("a", "Renamed", true), seat("b", "Bravo")], now: NOW + 1 }),
      first.state,
    );
    expect(changed.publication).toMatchObject({ host: "Renamed", teams: ["Renamed", "Bravo"] });
  });
});

describe("Directory view", () => {
  it("returns only fresh Rooms and buckets open lobbies and live games", () => {
    const old = listing({ code: "OLD", updatedAt: NOW - 21 * 60_000 });
    const open = listing({ code: "OPEN", seats: 5 });
    const full = listing({ code: "FULL", seats: 8 });
    const hiddenLobby = listing({ code: "SPEC", visibility: "spectatable" });
    const draft = listing({ code: "DRAFT", visibility: "spectatable", phase: "drafting" });
    const view = directoryView([old, open, full, hiddenLobby, draft], NOW);

    expect(view.rooms.map((item) => item.code)).not.toContain("OLD");
    expect(view.openLobbies.map((item) => item.code)).toEqual(["OPEN"]);
    expect(view.liveGames.map((item) => item.code)).toEqual(["DRAFT"]);
    expect(view.staleCodes).toEqual(["OLD"]);
  });

  it("orders lobbies by fullness and live games by phase then crowd", () => {
    const view = directoryView(
      [
        listing({ code: "CCCCC", seats: 2 }),
        listing({ code: "AAAAA", seats: 5 }),
        listing({ code: "BBBBB", seats: 2, rev: NOW + 1 }),
        listing({ code: "BCAST", phase: "broadcasting" }),
        listing({ code: "DRAFT", phase: "drafting" }),
        listing({ code: "ASSEM", phase: "assembled", watchers: 9 }),
      ],
      NOW,
    );
    expect(view.openLobbies.map((item) => item.code)).toEqual(["AAAAA", "BBBBB", "CCCCC"]);
    expect(view.liveGames.map((item) => item.code)).toEqual(["DRAFT", "ASSEM", "BCAST"]);
  });

  it("plans quiet probes, stale eviction, overflow, and the next tick", () => {
    const many = Array.from({ length: 203 }, (_, index) =>
      listing({
        code: `R${index}`,
        updatedAt: NOW - (index < 25 ? 7 * 60_000 + index : index),
      }),
    );
    const view = directoryView(many, NOW);
    expect(view.probeCodes).toHaveLength(20);
    expect(view.probeCodes[0]).toBe("R24");
    expect(view.overflowCodes).toEqual(["R24", "R23", "R22"]);
    expect(view.nextTickAt).toBeGreaterThan(NOW);
    expect(directoryView([], NOW).nextTickAt).toBeNull();
  });
});
