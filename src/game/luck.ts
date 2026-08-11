import type { LuckTrait } from "./types";

// ---------------------------------------------------------------------------
// Luck traits — certain players are occasionally carried by fate itself. The
// trait rides on the SimTeam into the tournament sim, where each game rolls
// it independently (seeded, so solo and versus derive the same story from
// the same seed). A proc doesn't tilt the odds — it takes the game outright.
// ---------------------------------------------------------------------------

interface LuckyPlayer {
  steamId: number;
  label: string;
  /** Per-game proc chance. */
  chance: number;
}

const LUCKY_PLAYERS: LuckyPlayer[] = [
  // Musu (Dick Chainy, OVR 1): some games the carry gets carried.
  { steamId: 9000000001, label: "La suerte del carreado", chance: 0.2 },
];

/** The luck trait a drafted roster carries, if any. */
export function luckTraitFor(roster: { steamId: number }[]): LuckTrait | undefined {
  for (const lucky of LUCKY_PLAYERS) {
    if (roster.some((r) => r.steamId === lucky.steamId)) {
      return { chance: lucky.chance, label: lucky.label };
    }
  }
  return undefined;
}
