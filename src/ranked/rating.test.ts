import { describe, expect, it } from "vitest";
import {
  ELO_DIVISOR,
  K_PLACEMENT,
  K_SETTLED,
  PLACEMENT_GAMES,
  RATING_FLOOR,
  TI_CHAMPION_BONUS,
  expectedScore,
  kFor,
  rateMatch,
  type RatedPlayer,
} from "./rating";

/** A settled 1000-rated player at a given finishing position. */
const player = (userId: string, place: number, over: Partial<RatedPlayer> = {}): RatedPlayer => ({
  userId,
  rating: 1000,
  gamesPlayed: PLACEMENT_GAMES,
  place,
  gamesWon: 0,
  ...over,
});

const changeOf = (changes: ReturnType<typeof rateMatch>, userId: string) => {
  const c = changes.find((x) => x.userId === userId);
  if (!c) throw new Error(`no change for ${userId}`);
  return c;
};

describe("expectedScore", () => {
  it("is 0.5 between equals and sums to 1 across a pair", () => {
    expect(expectedScore(1000, 1000)).toBe(0.5);
    expect(expectedScore(1200, 800) + expectedScore(800, 1200)).toBeCloseTo(1);
  });

  it("gives the standard 10x odds at one divisor of gap", () => {
    const e = expectedScore(1000 + ELO_DIVISOR, 1000);
    expect(e / (1 - e)).toBeCloseTo(10);
  });
});

describe("kFor", () => {
  it("uses the placement K until the settling game count", () => {
    expect(kFor(0)).toBe(K_PLACEMENT);
    expect(kFor(PLACEMENT_GAMES - 1)).toBe(K_PLACEMENT);
    expect(kFor(PLACEMENT_GAMES)).toBe(K_SETTLED);
  });
});

describe("rateMatch", () => {
  it("is zero-sum among equal-K players (no champion in the room)", () => {
    const changes = rateMatch([
      player("a", 3, { rating: 1100 }),
      player("b", 5, { rating: 950 }),
      player("c", 7, { rating: 1000 }),
      player("d", 9, { rating: 1234 }),
    ]);
    const total = changes.reduce((sum, c) => sum + c.exchange, 0);
    // Exact zero pre-rounding; per-player rounding can drift by at most n/2.
    expect(Math.abs(total)).toBeLessThanOrEqual(2);
  });

  it("scores a symmetric equal-rating match symmetrically", () => {
    const changes = rateMatch([
      player("a", 2),
      player("b", 4),
      player("c", 6),
      player("d", 8),
    ]);
    expect(changeOf(changes, "a").exchange).toBe(-changeOf(changes, "d").exchange);
    expect(changeOf(changes, "b").exchange).toBe(-changeOf(changes, "c").exchange);
    expect(changeOf(changes, "a").exchange).toBeGreaterThan(0);
    expect(changeOf(changes, "b").exchange).toBeGreaterThan(0);
  });

  it("pays a favorite little for beating a weak lobby, and charges a lot for losing to it", () => {
    const strongWins = changeOf(
      rateMatch([
        player("strong", 2, { rating: 1400 }),
        player("b", 4, { rating: 900 }),
        player("c", 6, { rating: 900 }),
        player("d", 8, { rating: 900 }),
      ]),
      "strong",
    );
    const strongLoses = changeOf(
      rateMatch([
        player("strong", 8, { rating: 1400 }),
        player("b", 2, { rating: 900 }),
        player("c", 4, { rating: 900 }),
        player("d", 6, { rating: 900 }),
      ]),
      "strong",
    );
    expect(strongWins.exchange).toBeGreaterThan(0);
    expect(Math.abs(strongLoses.exchange)).toBeGreaterThan(strongWins.exchange * 3);
  });

  it("breaks a shared placement by games won, and scores a residual tie as half", () => {
    const changes = rateMatch([
      player("wonMore", 9, { gamesWon: 3 }),
      player("wonLess", 9, { gamesWon: 1 }),
      player("tied1", 13, { gamesWon: 2 }),
      player("tied2", 13, { gamesWon: 2 }),
    ]);
    expect(changeOf(changes, "wonMore").exchange).toBeGreaterThan(
      changeOf(changes, "wonLess").exchange,
    );
    // The tied pair differ only via the shared opponents — identical deltas.
    expect(changeOf(changes, "tied1").exchange).toBe(changeOf(changes, "tied2").exchange);
  });

  it("swings placement-K players harder than settled ones for the same result", () => {
    const match = (gamesPlayed: number) =>
      changeOf(
        rateMatch([
          player("x", 2, { gamesPlayed }),
          player("b", 4),
          player("c", 6),
          player("d", 8),
        ]),
        "x",
      );
    expect(match(0).exchange).toBe(match(PLACEMENT_GAMES).exchange * 2);
  });

  it("pays the TI bonus only to the tournament champion", () => {
    const changes = rateMatch([
      player("champ", 1),
      player("b", 4),
      player("c", 6),
      player("d", 8),
    ]);
    expect(changeOf(changes, "champ").bonus).toBe(TI_CHAMPION_BONUS);
    expect(changeOf(changes, "b").bonus).toBe(0);
    expect(changeOf(changes, "champ").after).toBe(
      1000 + changeOf(changes, "champ").exchange + TI_CHAMPION_BONUS,
    );
  });

  it("clamps the result at the floor", () => {
    const changes = rateMatch([
      player("broke", 8, { rating: 3 }),
      player("b", 2, { rating: 0 }),
      player("c", 4, { rating: 0 }),
      player("d", 6, { rating: 0 }),
    ]);
    expect(changeOf(changes, "broke").after).toBe(RATING_FLOOR);
  });

  it("rejects duplicate players and lonely matches", () => {
    expect(() => rateMatch([player("a", 1)])).toThrow();
    expect(() => rateMatch([player("a", 1), player("a", 2)])).toThrow();
  });
});
