import type { SimResult } from "./types";

// ---------------------------------------------------------------------------
// Broadcast beat schedule — pure and React-free so both the solo client and
// the multiplayer room server (which paces the reveal with DO alarms) can
// derive the exact same sequence from a SimResult.
// ---------------------------------------------------------------------------

export type Beat =
  | { kind: "group"; group: "A" | "B"; ms: number }
  | { kind: "round"; roundIdx: number; ms: number }
  | { kind: "game"; roundIdx: number; matchIdx: number; upTo: number; ms: number }
  | { kind: "standings"; ms: number };

/**
 * Real TI main-event schedule: the lower bracket interleaves with the upper
 * so each LB round can absorb the freshly fallen UB losers.
 * Round indices: 0-2 = UB R1/SF/Final, 3-8 = LB R1..Final, 9 = Grand Final.
 */
export const ROUND_SCHEDULE = [0, 3, 1, 4, 5, 2, 6, 7, 8, 9];

const GROUP_MS = 2200;
const ROUND_MS = 1800;
const GAME_MS = 1000;

export function buildBeats(result: SimResult): Beat[] {
  const beats: Beat[] = [];
  // Reveal the group with fewer human teams first (solo: the user's group last).
  const humanCount = { A: 0, B: 0 };
  for (const g of result.groupAssign) if (g.team.ownerId != null) humanCount[g.group]++;
  const order: ("A" | "B")[] = humanCount.A <= humanCount.B ? ["A", "B"] : ["B", "A"];
  beats.push({ kind: "group", group: order[0], ms: GROUP_MS });
  beats.push({ kind: "group", group: order[1], ms: GROUP_MS });
  for (const roundIdx of ROUND_SCHEDULE) {
    const round = result.rounds[roundIdx];
    if (!round) continue;
    beats.push({ kind: "round", roundIdx, ms: ROUND_MS });
    round.matches.forEach((m, matchIdx) => {
      if (m.a.ownerId != null || m.b.ownerId != null) {
        for (let upTo = 1; upTo <= m.games.length; upTo++) {
          beats.push({ kind: "game", roundIdx, matchIdx, upTo, ms: GAME_MS });
        }
      }
    });
  }
  beats.push({ kind: "standings", ms: 0 });
  return beats;
}
