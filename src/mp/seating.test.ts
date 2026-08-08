import { describe, expect, it } from "vitest";
import type { Seat } from "./protocol";
import { seatPlayer, unseatPlayer } from "./seating";

const seat = (playerId: string, isHost = false, connected = true): Seat => ({
  playerId,
  name: `Team ${playerId}`,
  connected,
  isHost,
});

describe("multiplayer seating", () => {
  it("auto-assigns an open seat and makes the first drafter host", () => {
    const first = seatPlayer([], "a", "Alpha");
    const second = seatPlayer(first, "b", "Bravo");

    expect(second).toEqual([
      { playerId: "a", name: "Alpha", connected: true, isHost: true },
      { playerId: "b", name: "Bravo", connected: true, isHost: false },
    ]);
  });

  it("does not add a drafter when every seat is occupied", () => {
    const full = [seat("a", true), seat("b")];
    expect(seatPlayer(full, "c", "Charlie", 2)).toBe(full);
  });

  it("reconnects an existing drafter without changing their saved name or order", () => {
    const disconnected = [seat("a", true, false), seat("b")];
    expect(seatPlayer(disconnected, "a", "Stale query name")).toEqual([
      seat("a", true, true),
      seat("b"),
    ]);
  });

  it("vacates a seat and transfers hosting to the first remaining drafter", () => {
    expect(unseatPlayer([seat("a", true), seat("b"), seat("c")], "a")).toEqual([
      seat("b", true),
      seat("c"),
    ]);
  });
});
