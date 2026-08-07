import type { PlayerHeroStats, RosterPlayer, SynergyGroup, TeamStrength } from "./types";

// ---------------------------------------------------------------------------
// Team strength — faithful to the original formulas:
//   overall = round( avg(OVR) + heroBonus + chemBonus )
//   heroBonus: per player, min(1, gamesOnAssignedHero / 25), summed, × 1.5
//   chemBonus: for every synergy group fully inside the roster,
//              sizeMult{2:1, 3:1.6, 4:2.2, 5:3} × min(4, gamesTogether / 230),
//              summed and capped at 13
//   hero assignment (auto): the permutation of the 5 drafted heroes over the
//   5 players that maximizes total games-played-on-hero.
// ---------------------------------------------------------------------------

const HERO_FIT_MULT = 1.5;
const CHEM_GAMES_DIVISOR = 230;
const CHEM_PAIR_CAP = 4;
const CHEM_TOTAL_CAP = 13;
const CHEM_SIZE_MULT: Record<number, number> = { 2: 1, 3: 1.6, 4: 2.2, 5: 3 };

function heroFit(games: number): number {
  return games > 0 ? Math.min(1, games / 25) : 0;
}

/** The OVR points a player contributes for being on a hero they've played `games` on. */
export function heroFitBonus(games: number): number {
  return Math.round(heroFit(games) * HERO_FIT_MULT * 10) / 10;
}

function chemPairBonus(games: number): number {
  return Math.min(CHEM_PAIR_CAP, games / CHEM_GAMES_DIVISOR);
}

/** Display-rounded OVR points a synergy group of `size` players with `games` together adds. */
export function chemGroupBonus(size: number, games: number): number {
  return Math.round((CHEM_SIZE_MULT[size] ?? 1) * chemPairBonus(games) * 10) / 10;
}

/** All 120 permutations of [0..n-1]. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const walk = (acc: number[], rest: number[]) => {
    if (!rest.length) {
      out.push(acc);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      walk([...acc, rest[i]], rest.filter((_, j) => j !== i));
    }
  };
  walk(
    [],
    Array.from({ length: n }, (_, i) => i),
  );
  return out;
}

const PERMS_5 = permutations(5);

export function computeStrength(
  roster: RosterPlayer[],
  heroes: number[],
  phs: PlayerHeroStats,
  synergy: SynergyGroup[],
  manualAssign: Record<string, number> | null,
): TeamStrength {
  const base = roster.length ? roster.reduce((s, p) => s + p.ovr, 0) / roster.length : 0;
  const gamesOn = (steamId: number, heroId: number): number =>
    phs[String(steamId)]?.[String(heroId)]?.games ?? 0;

  // --- hero assignment ---
  let assignment: { heroId: number | null; games: number }[];
  if (manualAssign && Object.keys(manualAssign).length) {
    assignment = roster.map((p) => {
      const heroId = manualAssign[String(p.steamId)] ?? null;
      return { heroId, games: heroId != null ? gamesOn(p.steamId, heroId) : 0 };
    });
  } else {
    const cell = (pi: number, hi: number) =>
      pi < roster.length && hi < heroes.length ? gamesOn(roster[pi].steamId, heroes[hi]) : 0;
    let bestTotal = -1;
    let bestPerm = [0, 1, 2, 3, 4];
    for (const perm of PERMS_5) {
      let total = 0;
      for (let i = 0; i < 5; i++) total += cell(i, perm[i]);
      if (total > bestTotal) {
        bestTotal = total;
        bestPerm = perm;
      }
    }
    assignment = roster.map((p, i) => {
      const hi = bestPerm[i];
      const heroId = hi < heroes.length ? heroes[hi] : null;
      return { heroId, games: heroId != null ? gamesOn(p.steamId, heroId) : 0 };
    });
  }

  const heroBonus =
    Math.round(assignment.reduce((s, a) => s + heroFit(a.games), 0) * HERO_FIT_MULT * 10) / 10;

  // --- chemistry ---
  const ids = new Set(roster.map((p) => p.steamId));
  const idx = new Map(roster.map((p, i) => [p.steamId, i]));
  const names = new Map(roster.map((p) => [p.steamId, p.nickname]));
  const inTeam = synergy.filter((g) => g.ids.length >= 2 && g.ids.every((id) => ids.has(id)));

  let chem = 0;
  for (const g of inTeam) chem += (CHEM_SIZE_MULT[g.ids.length] ?? 1) * chemPairBonus(g.games);
  chem = Math.min(chem, CHEM_TOTAL_CAP);

  const chemEdges = inTeam
    .filter((g) => g.ids.length === 2)
    .map((g) => ({
      i: idx.get(g.ids[0]) ?? 0,
      j: idx.get(g.ids[1]) ?? 0,
      games: g.games,
      bonus: chemPairBonus(g.games),
    }));
  const chemTop = [...inTeam]
    .sort((a, b) => b.ids.length - a.ids.length || b.games - a.games)
    .slice(0, 4)
    .map((g) => ({
      names: g.ids.map((id) => names.get(id) ?? `#${id}`),
      games: g.games,
      bonus: Math.round((CHEM_SIZE_MULT[g.ids.length] ?? 1) * chemPairBonus(g.games) * 10) / 10,
    }));

  const chemBonus = Math.round(chem * 10) / 10;
  return {
    overall: Math.round(base + heroBonus + chemBonus),
    base: Math.round(base),
    heroBonus,
    chemBonus,
    assignment,
    chemEdges,
    chemTop,
  };
}
