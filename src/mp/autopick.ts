import { heroFitBonus } from "../game/strength";
import type { PlayerHeroStats } from "../game/types";
import { boardRoster, legalPicks, type EngineState } from "./engine";
import type { Action } from "./protocol";

// ---------------------------------------------------------------------------
// Timeout fallback: a decent, fully deterministic pick so an AFK friend ends
// up with a mediocre board, not a dead one. Prefers players (by OVR plus the
// best hero-fit already on the board) while player slots remain, then heroes
// by fit with the drafted roster. Never spends a Deny or a mulligan.
// ---------------------------------------------------------------------------

export function autopick(s: EngineState, seat: number, phs: PlayerHeroStats): Action {
  const picks = legalPicks(s, seat);
  if (!picks.length) return { type: "pass" };
  const spreadPlayers = s.currentPacks.flatMap((p) => p.players);
  const board = s.boards[seat];
  const gamesOn = (steamId: number, heroId: number) =>
    phs[String(steamId)]?.[String(heroId)]?.games ?? 0;

  const playerPicks = picks.filter((c) => c.kind === "player");
  if (playerPicks.length) {
    let best = playerPicks[0];
    let bestScore = -Infinity;
    for (const c of playerPicks) {
      if (c.kind !== "player") continue;
      const p = spreadPlayers.find((x) => x.steamId === c.steamId)!;
      const fit = board.heroes.length
        ? Math.max(...board.heroes.map((h) => heroFitBonus(gamesOn(p.steamId, h))))
        : 0;
      const score = p.ovr + fit;
      if (score > bestScore || (score === bestScore && c.steamId < (best as { steamId: number }).steamId)) {
        best = c;
        bestScore = score;
      }
    }
    return { type: "pick", card: best };
  }

  const roster = boardRoster(board);
  let best = picks[0];
  let bestScore = -Infinity;
  for (const c of picks) {
    if (c.kind !== "hero") continue;
    const score = roster.reduce((sum, p) => sum + heroFitBonus(gamesOn(p.steamId, c.heroId)), 0);
    if (score > bestScore || (score === bestScore && c.heroId < (best as { heroId: number }).heroId)) {
      best = c;
      bestScore = score;
    }
  }
  return { type: "pick", card: best };
}
