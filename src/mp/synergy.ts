import { chemGroupBonus } from "../game/strength";
import type { SynergyGroup } from "../game/types";

// ---------------------------------------------------------------------------
// Chemistry intel shown on pack cards during a versus draft:
//   "412g with YOUR LaNm (+1.8)"  — groups completed by players you hold
//   "800g with Ana — still undrafted" — the best partner nobody has taken yet
// Pure id-level math; the client maps ids to nicknames.
// ---------------------------------------------------------------------------

export interface SynergyHints {
  /** Synergy groups this card would complete with players already on YOUR board. */
  withYours: { partnerIds: number[]; games: number; bonus: number }[];
  /** Best pair partner still available in the draft (not on any board, not denied). */
  bestUndrafted: { partnerId: number; games: number } | null;
}

export function synergyHints(
  steamId: number,
  myPlayerIds: number[],
  takenSteamIds: number[],
  synergy: SynergyGroup[],
): SynergyHints {
  const mine = new Set(myPlayerIds);
  const taken = new Set(takenSteamIds);

  const withYours = synergy
    .filter(
      (g) =>
        g.ids.length >= 2 &&
        g.ids.includes(steamId) &&
        g.ids.every((id) => id === steamId || mine.has(id)),
    )
    .map((g) => ({
      partnerIds: g.ids.filter((id) => id !== steamId),
      games: g.games,
      bonus: chemGroupBonus(g.ids.length, g.games),
    }))
    .sort((a, b) => b.bonus - a.bonus)
    .slice(0, 3);

  let bestUndrafted: SynergyHints["bestUndrafted"] = null;
  for (const g of synergy) {
    if (g.ids.length !== 2 || !g.ids.includes(steamId)) continue;
    const partner = g.ids.find((id) => id !== steamId);
    if (partner == null || taken.has(partner)) continue;
    if (!bestUndrafted || g.games > bestUndrafted.games) {
      bestUndrafted = { partnerId: partner, games: g.games };
    }
  }
  return { withYours, bestUndrafted };
}
