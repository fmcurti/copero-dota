import { describe, expect, it } from "vitest";
import { buildBeats } from "./beats";
import { simulateTournament } from "./sim";
import type { SimTeam } from "./types";

const team = (id: string, strength: number, ownerId: string | null): SimTeam => ({
  id,
  name: id,
  strength,
  isUser: false,
  ownerId,
});

describe("taunt beats", () => {
  const bots = (n: number) => Array.from({ length: n }, (_, i) => team(`bot${i}`, 86, null));

  it("adds a taunt hold after every human-vs-human series, and only those", () => {
    const field = [team("h1", 90, "p1"), team("h2", 90, "p2"), ...bots(16)];
    const result = simulateTournament(field, 31337);
    const beats = buildBeats(result, false); // production mode (vitest sets DEV)

    const humanVsHuman = new Set<string>();
    result.rounds.forEach((round, roundIdx) =>
      round.matches.forEach((m, matchIdx) => {
        if (m.a.ownerId != null && m.b.ownerId != null) humanVsHuman.add(`${roundIdx}-${matchIdx}`);
      }),
    );

    expect(humanVsHuman.size).toBeGreaterThan(0); // this seed makes them meet
    const taunts = beats.filter((b) => b.kind === "taunt");
    expect(new Set(taunts.map((b) => b.roundIdx + "-" + b.matchIdx))).toEqual(humanVsHuman);

    // each taunt lands right after its series' final game beat
    for (const t of beats.keys()) {
      const b = beats[t];
      if (b.kind !== "taunt") continue;
      const prev = beats[t - 1];
      const match = result.rounds[b.roundIdx].matches[b.matchIdx];
      expect(prev).toMatchObject({
        kind: "game",
        roundIdx: b.roundIdx,
        matchIdx: b.matchIdx,
        upTo: match.games.length,
      });
    }
  });

  it("solo runs (one owned team) never get taunt beats in production", () => {
    const field = [team("me", 88, "solo"), ...bots(17)];
    const beats = buildBeats(simulateTournament(field, 2020), false);
    expect(beats.some((b) => b.kind === "taunt")).toBe(false);
  });

  it("dev preview taunts every series a human WINS, even vs bots", () => {
    const field = [team("me", 95, "solo"), ...bots(17)];
    const result = simulateTournament(field, 555);
    const beats = buildBeats(result, true);
    const expected = new Set<string>();
    result.rounds.forEach((round, roundIdx) =>
      round.matches.forEach((m, matchIdx) => {
        if (m.winner.ownerId != null) expected.add(`${roundIdx}-${matchIdx}`);
      }),
    );
    const taunts = beats.filter((b) => b.kind === "taunt");
    expect(new Set(taunts.map((b) => `${b.roundIdx}-${b.matchIdx}`))).toEqual(expected);
    expect(expected.size).toBeGreaterThan(0); // a 95-rated team wins something
  });
});
