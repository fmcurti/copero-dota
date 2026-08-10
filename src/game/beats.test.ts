import { describe, expect, it } from "vitest";
import { buildBeats, pickTaunt, revealAt, seriesSeed, tauntOwner } from "./beats";
import { matchdayCount, simulateTournament, standingsAfter } from "./sim";
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

// ---------------------------------------------------------------------------
// revealAt — beat N is on screen, what does that show?
// ---------------------------------------------------------------------------

describe("revealAt", () => {
  const field = [team("h1", 90, "p1"), team("h2", 90, "p2"), ...Array.from({ length: 16 }, (_, i) => team(`bot${i}`, 86, null))];
  const result = simulateTournament(field, 31337);
  const beats = buildBeats(result, false);
  const days = matchdayCount(result);
  const at = (idx: number) => revealAt(result, beats, idx);

  it("opens on the intro: nothing shown yet", () => {
    const r = at(0);
    expect(r.groupPhase).toBe("hidden");
    expect(r.groupUpTo).toBeNull();
    expect(r.roundsShown.size).toBe(0);
    expect(r.clash).toBeNull();
    expect(r.done).toBe(false);
    expect(r.phaseLabel).toBe("Opening");
  });

  it("keeps the group stage LIVE through the final matchday; Final waits for the stamp", () => {
    const lastTick = beats.findIndex((b) => b.kind === "groupRound" && b.upTo === days);
    const r = at(lastTick);
    expect(r.groupUpTo).toBe(days); // the last matchday is on screen…
    expect(r.groupPhase).toBe("live"); // …and still ticking: wash + dots render
    expect(r.phaseLabel).toBe(`Fase de Grupos · Jornada ${days}/${days}`);

    const stampIdx = beats.findIndex((b) => b.kind === "groupDone");
    expect(stampIdx).toBe(lastTick + 1);
    expect(at(stampIdx).groupPhase).toBe("stamped");
  });

  it("accumulates bracket rounds and human games monotonically", () => {
    const gameIdxs = beats
      .map((b, i) => (b.kind === "game" ? i : -1))
      .filter((i) => i >= 0);
    expect(gameIdxs.length).toBeGreaterThan(0);
    const lastGame = gameIdxs[gameIdxs.length - 1];
    const b = beats[lastGame] as Extract<(typeof beats)[number], { kind: "game" }>;
    const r = at(lastGame);
    expect(r.roundsShown.has(b.roundIdx)).toBe(true);
    expect(r.humanGames.get(`${b.roundIdx}-${b.matchIdx}`)).toBe(b.upTo);
    expect(r.clash).toEqual({ roundIdx: b.roundIdx, matchIdx: b.matchIdx });
    expect(r.phaseLabel).toBe(result.rounds[b.roundIdx].name);
    // earlier reveal state is a strict subset
    const prev = at(lastGame - 1);
    expect((prev.humanGames.get(`${b.roundIdx}-${b.matchIdx}`) ?? 0)).toBeLessThanOrEqual(b.upTo);
  });

  it("ends done: ceremony label, no clash, index clamped", () => {
    const r = at(beats.length - 1);
    expect(r.done).toBe(true);
    expect(r.phaseLabel).toBe("Ceremonia");
    expect(r.clash).toBeNull();
    expect(at(beats.length + 50)).toEqual(r); // out-of-range indices clamp
  });
});

describe("standingsAfter mirrors the sim", () => {
  const field = [team("h1", 90, "p1"), ...Array.from({ length: 17 }, (_, i) => team(`bot${i}`, 84 + (i % 8), null))];
  const result = simulateTournament(field, 99);
  const days = matchdayCount(result);

  it("day 0 is all zeros in seeded order; the final day IS the sim's own table", () => {
    for (const g of ["A", "B"] as const) {
      expect(standingsAfter(result, g, 0).every((s) => s.wins === 0 && s.losses === 0)).toBe(true);
      expect(standingsAfter(result, g, days)).toBe(result.groups[g]);
    }
  });

  it("replaying one day short then adding the last matches reaches the final table", () => {
    for (const g of ["A", "B"] as const) {
      const partial = standingsAfter(result, g, days - 1);
      const final = new Map(result.groups[g].map((s) => [s.team.id, s]));
      for (const s of partial) {
        const last = result.groupMatches.filter(
          (m) => m.group === g && m.round === days - 1 && (m.a.id === s.team.id || m.b.id === s.team.id),
        );
        const lastWins = last.reduce(
          (n, m) => n + m.games.filter((x) => (m.a.id === s.team.id ? x === "a" : x === "b")).length,
          0,
        );
        expect(s.wins + lastWins).toBe(final.get(s.team.id)!.wins);
      }
    }
  });
});

describe("the shared taunt formula", () => {
  it("pickTaunt is seriesSeed applied to the phrase list — one formula everywhere", () => {
    const phrases = ["a", "b", "c", "d", "e"];
    for (const [seed, r, m] of [
      [31337, 0, 0],
      [31337, 9, 0],
      [123456789, 5, 3],
      [-7, 2, 1], // negative seeds coerce like the server's (seed >>> 0)
    ] as const) {
      expect(pickTaunt(seed, r, m, phrases)).toBe(phrases[seriesSeed(seed, r, m) % phrases.length]);
    }
    expect(seriesSeed(31337, 1, 0)).not.toBe(seriesSeed(31337, 0, 1)); // rounds and matches don't collide
  });

  it("tauntOwner: production needs both humans; dev preview needs a human winner", () => {
    const h = (id: string) => team(id, 90, id);
    const bot = team("bot", 86, null);
    const m = (a: SimTeam, b: SimTeam, winner: SimTeam) =>
      ({ a, b, winner, loser: winner === a ? b : a }) as never;
    expect(tauntOwner(m(h("p1"), h("p2"), h("p1")), false)).toBe("p1");
    expect(tauntOwner(m(h("p1"), bot, h("p1")), false)).toBeNull();
    expect(tauntOwner(m(h("p1"), bot, h("p1")), true)).toBe("p1");
    expect(tauntOwner(m(h("p1"), bot, bot), true)).toBeNull();
  });
});
