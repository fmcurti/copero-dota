import { describe, expect, it } from "vitest";
import { luckTraitFor } from "./luck";
import { simulateTournament } from "./sim";
import type { SimTeam } from "./types";

const MUSU_ID = 9000000001;

const team = (id: string, strength: number, luck?: SimTeam["luck"]): SimTeam => ({
  id,
  name: id,
  strength,
  isUser: false,
  ownerId: id.startsWith("lucky") ? id : null,
  ...(luck ? { luck } : {}),
});

describe("luckTraitFor", () => {
  it("derives the Musu trait from a roster containing him", () => {
    const trait = luckTraitFor([{ steamId: MUSU_ID }, { steamId: 1 }]);
    expect(trait).toEqual({ chance: 0.2, label: "La suerte del carreado" });
  });

  it("is undefined for rosters without a lucky player", () => {
    expect(luckTraitFor([{ steamId: 1 }])).toBeUndefined();
  });
});

describe("luck in the sim", () => {
  const bots = (n: number) => Array.from({ length: n }, (_, i) => team(`bot${i}`, 90));

  it("a guaranteed proc wins every single game outright, even at strength 1", () => {
    const lucky = team("lucky", 1, { chance: 1, label: "La suerte del carreado" });
    const res = simulateTournament([lucky, ...bots(17)], 12345);
    expect(res.champion.id).toBe("lucky");
    expect(res.ownerStats.lucky.undefeated).toBe(true);
    expect(res.ownerStats.lucky.gamesLost).toBe(0);
    // every luck roll for the lucky side is recorded as a proc
    for (const m of [...res.groupMatches, ...res.rounds.flatMap((r) => r.matches)]) {
      if (m.a.id !== "lucky" && m.b.id !== "lucky") continue;
      expect(m.luckGames).toHaveLength(m.games.length);
      for (const roll of m.luckGames!) expect(m.a.id === "lucky" ? roll.a : roll.b).toBe(true);
    }
  });

  it("chance 0 never procs but still records the rolls", () => {
    const lucky = team("lucky", 85, { chance: 0, label: "La suerte del carreado" });
    const res = simulateTournament([lucky, ...bots(17)], 999);
    let sawGames = 0;
    for (const m of res.groupMatches) {
      if (m.a.id !== "lucky" && m.b.id !== "lucky") continue;
      sawGames += m.games.length;
      for (const roll of m.luckGames!) {
        expect(roll.a).toBe(false);
        expect(roll.b).toBe(false);
      }
    }
    expect(sawGames).toBeGreaterThan(0);
  });

  it("two lucky teams cancel out and the game resolves normally", () => {
    const l1 = team("lucky1", 80, { chance: 1, label: "La suerte del carreado" });
    const l2 = team("lucky2", 80, { chance: 1, label: "La suerte del carreado" });
    const res = simulateTournament([l1, l2, ...bots(16)], 2024);
    // both stomp every bot, so the final comes down to the two of them
    expect(["lucky1", "lucky2"]).toContain(res.champion.id);
    const head2head = [...res.groupMatches, ...res.rounds.flatMap((r) => r.matches)].filter(
      (m) => m.a.id.startsWith("lucky") && m.b.id.startsWith("lucky"),
    );
    expect(head2head.length).toBeGreaterThan(0);
    for (const m of head2head) for (const roll of m.luckGames!) expect(roll).toEqual({ a: true, b: true });
  });

  it("matches without a lucky side carry no luckGames", () => {
    const res = simulateTournament([team("plain", 85), ...bots(17)], 4242);
    for (const m of [...res.groupMatches, ...res.rounds.flatMap((r) => r.matches)]) {
      expect(m.luckGames).toBeUndefined();
    }
  });

  it("is deterministic for a given seed", () => {
    const lucky = team("lucky", 60, { chance: 0.05, label: "La suerte del carreado" });
    const a = simulateTournament([lucky, ...bots(17)], 777);
    const b = simulateTournament([lucky, ...bots(17)], 777);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
