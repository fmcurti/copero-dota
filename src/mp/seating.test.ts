import { describe, expect, it } from "vitest";
import type { Seat } from "./protocol";
import { NAME_MAX } from "./protocol";
import { nameTaken, seatPlayer, uniqueName, unseatPlayer } from "./seating";

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

describe("unique team names", () => {
  const taken = [
    { playerId: "a", name: "Alianza", connected: true, isHost: true },
    { playerId: "b", name: "Los Fumadores", connected: true, isHost: false },
  ];

  it("ignores case and padding when comparing", () => {
    expect(nameTaken(taken, "alianza")).toBe(true);
    expect(nameTaken(taken, "  ALIANZA  ")).toBe(true);
    expect(nameTaken(taken, "Alianza FC")).toBe(false);
  });

  it("lets a drafter keep their own name", () => {
    expect(nameTaken(taken, "Alianza", "a")).toBe(false);
    expect(nameTaken(taken, "Alianza", "b")).toBe(true);
  });

  it("leaves a free name alone and numbers a colliding one", () => {
    expect(uniqueName(taken, "OG")).toBe("OG");
    expect(uniqueName(taken, "Alianza")).toBe("Alianza 2");
    expect(uniqueName([...taken, { ...taken[0], playerId: "c", name: "Alianza 2" }], "Alianza")).toBe(
      "Alianza 3",
    );
  });

  it("keeps a numbered name inside the length cap", () => {
    const long = "X".repeat(NAME_MAX);
    const next = uniqueName([{ playerId: "a", name: long, connected: true, isHost: true }], long);
    expect(next.length).toBeLessThanOrEqual(NAME_MAX);
    expect(next.endsWith(" 2")).toBe(true);
  });

  it("disambiguates on arrival — everyone shares one default name", () => {
    const seats = seatPlayer(seatPlayer([], "a", "Your Team"), "b", "Your Team");
    expect(seats.map((s) => s.name)).toEqual(["Your Team", "Your Team 2"]);
  });
});
