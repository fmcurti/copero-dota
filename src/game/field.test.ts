import { describe, expect, it } from "vitest";
import {
  MULTI_AI_MEAN_CAP,
  SOLO_AI_MEAN,
  generateField,
  generateFieldMulti,
  multiplayerAiMean,
  type HumanSeed,
} from "./field";

function humans(...strengths: number[]): HumanSeed[] {
  return strengths.map((strength, index) => ({
    ownerId: `player-${index}`,
    name: `Player ${index}`,
    strength,
  }));
}

describe("tournament field difficulty", () => {
  it("caps the multiplayer bot mean at two points above solo", () => {
    expect(MULTI_AI_MEAN_CAP).toBe(SOLO_AI_MEAN + 2);
    expect(multiplayerAiMean(humans(99, 98, 97))).toBe(88);
  });

  it("still scales down for a lower-rated lobby", () => {
    expect(multiplayerAiMean(humans(84, 84))).toBe(80);
  });

  it("keeps the solo bot field pinned to its original mean", () => {
    const seed = 12345;
    const soloBots = generateField(99, "Solo", seed)
      .filter((team) => team.ownerId == null)
      .map((team) => team.strength);
    const explicitlyPinnedBots = generateFieldMulti(humans(99), seed, SOLO_AI_MEAN)
      .filter((team) => team.ownerId == null)
      .map((team) => team.strength);

    expect(soloBots).toEqual(explicitlyPinnedBots);
  });
});
