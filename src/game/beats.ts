import type { SimResult } from "./types";

// ---------------------------------------------------------------------------
// Broadcast beat schedule — pure and React-free so both the solo client and
// the multiplayer room server (which paces the reveal with DO alarms) can
// derive the exact same sequence from a SimResult.
//
// The show, in order:
//   intro        — tournament title card
//   groupRound 0 — both group boards open at 0–0
//   groupRound n — matchday n lands: tallies tick, rows climb and fall live
//   groupDone    — qualification cuts stamp in (upper / lower / eliminated)
//   round        — a bracket round is revealed (bot series land decided)
//   clash        — VS plate for a series with a human team in it
//   game         — one game of a human series ticks in
//   taunt        — human-vs-human series just ended: hold for the winner's
//                  victory phrase (and let the result breathe)
//   standings    — champion ceremony + final placements
// ---------------------------------------------------------------------------

export type Beat =
  | { kind: "intro"; ms: number }
  | { kind: "groupRound"; upTo: number; ms: number } // standings after matchdays < upTo
  | { kind: "groupDone"; ms: number }
  | { kind: "round"; roundIdx: number; ms: number }
  | { kind: "clash"; roundIdx: number; matchIdx: number; ms: number }
  | { kind: "game"; roundIdx: number; matchIdx: number; upTo: number; ms: number }
  | { kind: "taunt"; roundIdx: number; matchIdx: number; ms: number }
  | { kind: "standings"; ms: number };

/**
 * Real TI main-event schedule: the lower bracket interleaves with the upper
 * so each LB round can absorb the freshly fallen UB losers.
 * Round indices: 0-2 = UB R1/SF/Final, 3-8 = LB R1..Final, 9 = Grand Final.
 */
export const ROUND_SCHEDULE = [0, 3, 1, 4, 5, 2, 6, 7, 8, 9];

const INTRO_MS = 1900;
const GROUP_OPEN_MS = 1100;
const GROUP_TICK_MS = 850; // one matchday of the live ticker
const GROUP_DONE_MS = 2300;
const ROUND_MS = 1700;
const CLASH_MS = 1500; // VS plate slam for human series
const GAME_MS = 950;
const TAUNT_MS = 2800; // hold on a human-vs-human result for the victory phrase

export function buildBeats(result: SimResult): Beat[] {
  const beats: Beat[] = [];
  beats.push({ kind: "intro", ms: INTRO_MS });

  // Live group stage: both groups tick matchday by matchday.
  const matchdays = result.groupMatches.reduce((m, g) => Math.max(m, g.round + 1), 0);
  beats.push({ kind: "groupRound", upTo: 0, ms: GROUP_OPEN_MS });
  for (let day = 1; day <= matchdays; day++) {
    beats.push({ kind: "groupRound", upTo: day, ms: GROUP_TICK_MS });
  }
  beats.push({ kind: "groupDone", ms: GROUP_DONE_MS });

  for (const roundIdx of ROUND_SCHEDULE) {
    const round = result.rounds[roundIdx];
    if (!round) continue;
    beats.push({ kind: "round", roundIdx, ms: ROUND_MS });
    round.matches.forEach((m, matchIdx) => {
      if (m.a.ownerId != null || m.b.ownerId != null) {
        beats.push({ kind: "clash", roundIdx, matchIdx, ms: CLASH_MS });
        for (let upTo = 1; upTo <= m.games.length; upTo++) {
          beats.push({ kind: "game", roundIdx, matchIdx, upTo, ms: GAME_MS });
        }
        if (m.a.ownerId != null && m.b.ownerId != null) {
          beats.push({ kind: "taunt", roundIdx, matchIdx, ms: TAUNT_MS });
        }
      }
    });
  }
  beats.push({ kind: "standings", ms: 0 });
  return beats;
}
