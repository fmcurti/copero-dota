import { describe, expect, it } from "vitest";
import { swapHeroAssignment } from "./strength";

describe("swapHeroAssignment", () => {
  it("swaps the selected hero with its current player", () => {
    const original = { "101": 1, "202": 2, "303": 3 };

    expect(swapHeroAssignment(original, "101", 2)).toEqual({
      "101": 2,
      "202": 1,
      "303": 3,
    });
    expect(original).toEqual({ "101": 1, "202": 2, "303": 3 });
  });

  it("assigns an unclaimed hero without changing the other players", () => {
    expect(swapHeroAssignment({ "101": 1 }, "202", 2)).toEqual({
      "101": 1,
      "202": 2,
    });
  });
});
