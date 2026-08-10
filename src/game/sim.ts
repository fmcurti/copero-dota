import { mulberry32, type Rng } from "./rng";
import type {
  BracketMatch,
  BracketRound,
  FinalStanding,
  GroupGameRow,
  GroupStanding,
  OwnerStats,
  SimResult,
  SimTeam,
} from "./types";

// ---------------------------------------------------------------------------
// The International simulation — faithful port of the original:
//  - 18 teams, snake-seeded into two groups of 9 by strength
//    (sorted desc; index % 4 ∈ {0,3} → group A, else group B)
//  - Groups: full round-robin, Bo2 (two independent games per pairing)
//  - Per-game win probability: 1 / (1 + 10^(-(A-B)/22))   (Elo-like, div 22)
//  - 9th of each group finishes 17th/18th
//  - TI-style double-elimination bracket: top 4 per group → upper bracket,
//    5th-8th → lower bracket round 1. Bo3 everywhere, Bo5 grand final.
//  - "322-0": winning the whole thing without losing a single game.
// ---------------------------------------------------------------------------

const ELO_DIVISOR = 22;

export function winProb(a: SimTeam, b: SimTeam): number {
  return 1 / (1 + Math.pow(10, -(a.strength - b.strength) / ELO_DIVISOR));
}

/** The group tiebreak: wins, then seeded strength, then stable id. */
const groupTiebreak = (x: GroupStanding, y: GroupStanding): number =>
  y.wins - x.wins || y.team.strength - x.team.strength || x.team.id.localeCompare(y.team.id);

/** Total group matchdays in a finished sim. */
export function matchdayCount(result: SimResult): number {
  return result.groupMatches.reduce((m, g) => Math.max(m, g.round + 1), 0);
}

/**
 * Standings after the first `days` matchdays — the exact table the sim would
 * print at that moment (same tiebreak). The reveal's live ticker replays the
 * group stage through this, so the final table always matches the sim's own.
 */
export function standingsAfter(
  result: SimResult,
  group: "A" | "B",
  days: number,
): GroupStanding[] {
  if (days >= matchdayCount(result)) return result.groups[group]; // final: the sim's own table
  const teams = result.groupAssign.filter((g) => g.group === group).map((g) => g.team);
  const wins = new Map(teams.map((t) => [t.id, 0]));
  const losses = new Map(teams.map((t) => [t.id, 0]));
  for (const m of result.groupMatches) {
    if (m.group !== group || m.round >= days) continue;
    const aWins = m.games.filter((g) => g === "a").length;
    wins.set(m.a.id, wins.get(m.a.id)! + aWins);
    losses.set(m.a.id, losses.get(m.a.id)! + (m.games.length - aWins));
    wins.set(m.b.id, wins.get(m.b.id)! + (m.games.length - aWins));
    losses.set(m.b.id, losses.get(m.b.id)! + aWins);
  }
  return teams
    .map((t) => ({ team: t, wins: wins.get(t.id)!, losses: losses.get(t.id)! }))
    .sort(groupTiebreak);
}

/**
 * One game. Luck traits roll per game BEFORE the result: a proc takes the
 * game outright — la suerte del carreado doesn't negotiate with Elo. If both
 * sides proc, the luck cancels and the game resolves normally. rng is
 * consumed only for sides that carry a trait, so trait-free sims draw the
 * same stream.
 */
function playGame(
  a: SimTeam,
  b: SimTeam,
  rng: Rng,
): { winner: "a" | "b"; luck: { a: boolean; b: boolean } } {
  const luckA = a.luck != null && rng() < a.luck.chance;
  const luckB = b.luck != null && rng() < b.luck.chance;
  const luck = { a: luckA, b: luckB };
  if (luckA !== luckB) return { winner: luckA ? "a" : "b", luck };
  return { winner: rng() < winProb(a, b) ? "a" : "b", luck };
}

function playSeries(id: string, a: SimTeam, b: SimTeam, bestOf: number, rng: Rng): BracketMatch {
  const need = Math.ceil(bestOf / 2);
  let winsA = 0;
  let winsB = 0;
  const games: ("a" | "b")[] = [];
  const luckGames: { a: boolean; b: boolean }[] = [];
  while (winsA < need && winsB < need) {
    const g = playGame(a, b, rng);
    if (g.winner === "a") winsA++;
    else winsB++;
    games.push(g.winner);
    luckGames.push(g.luck);
  }
  const aWon = winsA > winsB;
  return {
    id,
    a,
    b,
    scoreA: winsA,
    scoreB: winsB,
    winner: aWon ? a : b,
    loser: aWon ? b : a,
    bestOf,
    games,
    ...(a.luck || b.luck ? { luckGames } : {}),
  };
}

/** Round-robin pairings via the circle method. */
function roundRobinRounds(n: number): [number, number][][] {
  const idx = [...Array(n).keys()];
  if (n % 2) idx.push(-1);
  const m = idx.length;
  const rounds: [number, number][][] = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < m / 2; i++) {
      const a = idx[i];
      const b = idx[m - 1 - i];
      if (a !== -1 && b !== -1) pairs.push([a, b]);
    }
    idx.splice(1, 0, idx.pop()!);
    rounds.push(pairs);
  }
  return rounds;
}

function playGroup(
  teams: SimTeam[],
  label: string,
  rng: Rng,
): { rounds: GroupGameRow[][]; standings: GroupStanding[] } {
  const wins = new Map(teams.map((t) => [t.id, 0]));
  const losses = new Map(teams.map((t) => [t.id, 0]));
  const rounds = roundRobinRounds(teams.length).map((pairs, r) =>
    pairs.map(([ai, bi], m) => {
      const a = teams[ai];
      const b = teams[bi];
      const games: ("a" | "b")[] = [];
      const luckGames: { a: boolean; b: boolean }[] = [];
      for (let g = 0; g < 2; g++) {
        const played = playGame(a, b, rng);
        games.push(played.winner);
        luckGames.push(played.luck);
      }
      const aWins = games.filter((g) => g === "a").length;
      wins.set(a.id, wins.get(a.id)! + aWins);
      wins.set(b.id, wins.get(b.id)! + (2 - aWins));
      losses.set(a.id, losses.get(a.id)! + (2 - aWins));
      losses.set(b.id, losses.get(b.id)! + aWins);
      return {
        id: `g${label}-${r}-${m}`,
        group: label,
        round: r,
        a,
        b,
        games,
        ...(a.luck || b.luck ? { luckGames } : {}),
      };
    }),
  );
  const standings = teams
    .map((t) => ({ team: t, wins: wins.get(t.id)!, losses: losses.get(t.id)! }))
    .sort(groupTiebreak);
  return { rounds, standings };
}

export function simulateTournament(field: SimTeam[], simSeed: number): SimResult {
  const rng = mulberry32(simSeed ^ 0x9e3779b9);

  // --- snake seeding into groups ---
  const sorted = [...field].sort((a, b) => b.strength - a.strength);
  const teamsA: SimTeam[] = [];
  const teamsB: SimTeam[] = [];
  const groupAssign: { team: SimTeam; group: "A" | "B" }[] = [];
  sorted.forEach((t, i) => {
    const group = i % 4 === 0 || i % 4 === 3 ? "A" : "B";
    (group === "A" ? teamsA : teamsB).push(t);
    groupAssign.push({ team: t, group });
  });

  // --- group stage ---
  const groupA = playGroup(teamsA, "A", rng);
  const groupB = playGroup(teamsB, "B", rng);
  const u = groupA.standings;
  const d = groupB.standings;
  const groupMatches: GroupGameRow[] = [];
  const maxRounds = Math.max(groupA.rounds.length, groupB.rounds.length);
  for (let i = 0; i < maxRounds; i++) {
    if (groupA.rounds[i]) groupMatches.push(...groupA.rounds[i]);
    if (groupB.rounds[i]) groupMatches.push(...groupB.rounds[i]);
  }

  const standings: FinalStanding[] = [];
  const placeAll = (label: string, place: number, teams: SimTeam[]) =>
    teams.forEach((team) => standings.push({ place, label, team }));
  placeAll("17th", 17, [u[8].team]);
  placeAll("18th", 18, [d[8].team]);

  // --- playoff bracket ---
  const rounds: BracketRound[] = [];
  let matchCounter = 0;
  const play = (a: SimTeam, b: SimTeam, bestOf: number) =>
    playSeries(`p${matchCounter++}`, a, b, bestOf, rng);

  const ubR1 = [
    play(u[0].team, d[3].team, 3),
    play(d[0].team, u[3].team, 3),
    play(u[1].team, d[2].team, 3),
    play(d[1].team, u[2].team, 3),
  ];
  rounds.push({ name: "Upper Bracket — Round 1", matches: ubR1 });
  const ubR1W = ubR1.map((m) => m.winner);
  const ubR1L = ubR1.map((m) => m.loser);

  const ubSF = [play(ubR1W[0], ubR1W[1], 3), play(ubR1W[2], ubR1W[3], 3)];
  rounds.push({ name: "Upper Bracket — Semifinal", matches: ubSF });
  const ubSFW = ubSF.map((m) => m.winner);
  const ubSFL = ubSF.map((m) => m.loser);

  const ubFinal = play(ubSFW[0], ubSFW[1], 3);
  rounds.push({ name: "Upper Bracket — Final", matches: [ubFinal] });

  const lbR1 = [
    play(u[4].team, d[7].team, 3),
    play(d[4].team, u[7].team, 3),
    play(u[5].team, d[6].team, 3),
    play(d[5].team, u[6].team, 3),
  ];
  rounds.push({ name: "Lower Bracket — Round 1", matches: lbR1 });
  placeAll(
    "13–16th",
    13,
    lbR1.map((m) => m.loser),
  );

  const lbR1W = lbR1.map((m) => m.winner);
  const lbR2 = [
    play(lbR1W[0], ubR1L[3], 3),
    play(lbR1W[1], ubR1L[2], 3),
    play(lbR1W[2], ubR1L[1], 3),
    play(lbR1W[3], ubR1L[0], 3),
  ];
  rounds.push({ name: "Lower Bracket — Round 2", matches: lbR2 });
  placeAll(
    "9–12th",
    9,
    lbR2.map((m) => m.loser),
  );

  const lbR2W = lbR2.map((m) => m.winner);
  const lbR3 = [play(lbR2W[0], lbR2W[1], 3), play(lbR2W[2], lbR2W[3], 3)];
  rounds.push({ name: "Lower Bracket — Round 3", matches: lbR3 });
  placeAll(
    "7–8th",
    7,
    lbR3.map((m) => m.loser),
  );

  const lbR3W = lbR3.map((m) => m.winner);
  const lbR4 = [play(lbR3W[0], ubSFL[1], 3), play(lbR3W[1], ubSFL[0], 3)];
  rounds.push({ name: "Lower Bracket — Round 4", matches: lbR4 });
  placeAll(
    "5–6th",
    5,
    lbR4.map((m) => m.loser),
  );

  const lbR4W = lbR4.map((m) => m.winner);
  const lbR5 = play(lbR4W[0], lbR4W[1], 3);
  rounds.push({ name: "Lower Bracket — Round 5", matches: [lbR5] });
  placeAll("4th", 4, [lbR5.loser]);

  const lbFinal = play(lbR5.winner, ubFinal.loser, 3);
  rounds.push({ name: "Lower Bracket — Final", matches: [lbFinal] });
  placeAll("3rd", 3, [lbFinal.loser]);

  const grandFinal = play(ubFinal.winner, lbFinal.winner, 5);
  rounds.push({ name: "Grand Final", matches: [grandFinal] });
  placeAll("2nd", 2, [grandFinal.loser]);
  placeAll("1st", 1, [grandFinal.winner]);
  standings.sort((a, b) => a.place - b.place);

  // --- per-owner stats (every human-owned team) ---
  const champion = grandFinal.winner;
  const ownerStats: Record<string, OwnerStats> = {};
  for (const team of field) {
    if (team.ownerId == null) continue;
    let gamesWon = 0;
    let gamesLost = 0;
    let groupGamesLost = 0;
    const tally = (games: ("a" | "b")[], teamIsA: boolean, isGroup: boolean) => {
      for (const g of games) {
        if ((g === "a") === teamIsA) gamesWon++;
        else {
          gamesLost++;
          if (isGroup) groupGamesLost++;
        }
      }
    };
    for (const m of groupMatches) {
      if (m.a.id === team.id) tally(m.games, true, true);
      else if (m.b.id === team.id) tally(m.games, false, true);
    }
    for (const round of rounds) {
      for (const m of round.matches) {
        if (m.a.id === team.id) tally(m.games, true, false);
        else if (m.b.id === team.id) tally(m.games, false, false);
      }
    }
    const standing = standings.find((s) => s.team.id === team.id)!;
    ownerStats[team.ownerId] = {
      place: standing.place,
      label: standing.label,
      undefeated: champion.id === team.id && gamesLost === 0,
      flawlessGroup: groupGamesLost === 0,
      gamesWon,
      gamesLost,
    };
  }

  // Solo-compat fields: the perspective of the isUser team (or first owned team).
  const userTeam = field.find((t) => t.isUser) ?? field.find((t) => t.ownerId != null);
  const us = userTeam?.ownerId != null ? ownerStats[userTeam.ownerId] : null;

  return {
    seed: simSeed,
    groupAssign,
    groupMatches,
    groups: { A: u, B: d },
    rounds,
    standings,
    champion,
    ownerStats,
    userPlace: us?.place ?? 0,
    userLabel: us?.label ?? "",
    userUndefeated: us?.undefeated ?? false,
    flawlessGroup: us?.flawlessGroup ?? false,
    gamesWon: us?.gamesWon ?? 0,
    gamesLost: us?.gamesLost ?? 0,
  };
}
