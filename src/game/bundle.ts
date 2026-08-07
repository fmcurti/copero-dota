import type { DataBundle } from "./types";

// React-free bundle loading — shared by the browser client (src/game/data.ts
// wraps this with hooks) and the versus room server (which injects a fetcher
// backed by the Worker's ASSETS binding).

/** Fetches one /data JSON file by name. */
export type JsonFetcher = (name: string) => Promise<unknown>;

/**
 * The source data carries a couple of dirty team names (e.g. the Peruvian
 * team literally named "unknown" appears as "unknown#####"). Strip the
 * artifact; fall back to the tag if nothing readable remains.
 */
function cleanTeamName(p: DataBundle["packs"][number]): DataBundle["packs"][number] {
  const teamName = p.teamName.replace(/#+/g, "").trim() || (p.tag ?? `Team ${p.teamId}`);
  return teamName === p.teamName ? p : { ...p, teamName };
}

export async function fetchBundle(fetchJson: JsonFetcher): Promise<DataBundle> {
  const [events, packs, heroes, playerHeroStats, squadSynergy] = await Promise.all([
    fetchJson("events.json") as Promise<DataBundle["events"]>,
    fetchJson("packs.json") as Promise<DataBundle["packs"]>,
    fetchJson("heroes.json") as Promise<DataBundle["heroes"]>,
    fetchJson("playerHeroStats.json") as Promise<DataBundle["playerHeroStats"]>,
    fetchJson("squadSynergy.json") as Promise<DataBundle["squadSynergy"]>,
  ]);
  return { events, packs: packs.map(cleanTeamName), heroes, playerHeroStats, squadSynergy };
}
