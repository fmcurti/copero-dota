import { matchdayCount } from "./sim";
import type { BracketMatch, SimResult } from "./types";

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

/**
 * Dev preview: under `npm run dev` (vite sets DEV for the client AND the
 * worker, so both sides always agree), taunt beats follow EVERY series a
 * human wins — including vs bots and in solo — so victory phrases can be
 * tested without needing two drafters to meet in the bracket. Production
 * builds compile this to false: taunts stay human-vs-human only.
 */
export const DEV_TAUNT_ALL = Boolean(
  (import.meta as { env?: { DEV?: boolean } }).env?.DEV,
);

const INTRO_MS = 1900;
const GROUP_OPEN_MS = 1100;
const GROUP_TICK_MS = 850; // one matchday of the live ticker
const GROUP_DONE_MS = 2300;
const ROUND_MS = 1700;
const CLASH_MS = 1500; // VS plate slam for human series
const GAME_MS = 950;
const TAUNT_MS = 2800; // hold on a human-vs-human result for the victory phrase

export function buildBeats(result: SimResult, tauntAll: boolean = DEV_TAUNT_ALL): Beat[] {
  const beats: Beat[] = [];
  beats.push({ kind: "intro", ms: INTRO_MS });

  // Live group stage: both groups tick matchday by matchday.
  const matchdays = matchdayCount(result);
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
        if (tauntOwner(m, tauntAll) != null) {
          beats.push({ kind: "taunt", roundIdx, matchIdx, ms: TAUNT_MS });
        }
      }
    });
  }
  beats.push({ kind: "standings", ms: 0 });
  return beats;
}

// ---------------------------------------------------------------------------
// The meaning of a beat. Everything below answers "beat N is on screen —
// what does that show?" in one place, for the renderer, the room server,
// and the tests alike.
// ---------------------------------------------------------------------------

/**
 * Whose victory phrase a taunt on this series belongs to, or null if the
 * series taunts nobody. The single statement of taunt eligibility: dev
 * preview taunts any series a human wins; production needs a human loser too.
 */
export function tauntOwner(m: BracketMatch, tauntAll: boolean = DEV_TAUNT_ALL): string | null {
  const eligible = tauntAll
    ? m.winner.ownerId != null
    : m.a.ownerId != null && m.b.ownerId != null;
  return eligible ? m.winner.ownerId : null;
}

/** One deterministic stream per series — seeds the taunt pick AND the scream
 *  bubble's jagged shape, identically on every client and the server. */
export function seriesSeed(simSeed: number, roundIdx: number, matchIdx: number): number {
  return (simSeed >>> 0) + roundIdx * 1009 + matchIdx * 101;
}

/** The winner's phrase for a series — same index wherever it is resolved. */
export function pickTaunt(
  simSeed: number,
  roundIdx: number,
  matchIdx: number,
  phrases: string[],
): string {
  return phrases[seriesSeed(simSeed, roundIdx, matchIdx) % phrases.length];
}

/** Everything beat `idx` puts on screen. */
export interface RevealState {
  /** The current beat (idx clamped to the schedule). */
  cur: Beat;
  /** On the last beat: the reveal is over, show the ceremony. */
  done: boolean;
  /** Total group matchdays. */
  days: number;
  /** Matchdays already on screen, or null before the group boards mount. */
  groupUpTo: number | null;
  /** hidden → live (ticker running, final matchday included) → stamped (cuts in). */
  groupPhase: "hidden" | "live" | "stamped";
  /** Bracket rounds revealed so far. */
  roundsShown: Set<number>;
  /** Games revealed per human series, keyed `${roundIdx}-${matchIdx}`. */
  humanGames: Map<string, number>;
  /** The human series in the fixed clash strip right now, if any. */
  clash: { roundIdx: number; matchIdx: number } | null;
  /** Broadcast-bar label for this moment. */
  phaseLabel: string;
}

/** Fold the schedule up to `idx` into what is visible — the reveal state machine. */
export function revealAt(result: SimResult, beats: Beat[], idx: number): RevealState {
  const clamped = Math.min(idx, beats.length - 1);
  const cur = beats[clamped];
  const done = clamped >= beats.length - 1;
  const days = matchdayCount(result);

  let groupUpTo: number | null = null;
  let stamped = false;
  const roundsShown = new Set<number>();
  const humanGames = new Map<string, number>();
  for (let i = 0; i <= clamped; i++) {
    const b = beats[i];
    if (b.kind === "groupRound") groupUpTo = Math.max(groupUpTo ?? 0, b.upTo);
    else if (b.kind === "groupDone") stamped = true;
    else if (b.kind === "round") roundsShown.add(b.roundIdx);
    else if (b.kind === "game") {
      const key = `${b.roundIdx}-${b.matchIdx}`;
      humanGames.set(key, Math.max(humanGames.get(key) ?? 0, b.upTo));
    }
  }

  const clash =
    !done && (cur.kind === "clash" || cur.kind === "game" || cur.kind === "taunt")
      ? { roundIdx: cur.roundIdx, matchIdx: cur.matchIdx }
      : null;

  const phaseLabel = done
    ? "Ceremonia"
    : cur.kind === "intro"
      ? "Opening"
      : cur.kind === "groupRound" || cur.kind === "groupDone"
        ? `Fase de Grupos${cur.kind === "groupRound" && cur.upTo > 0 ? ` · Jornada ${cur.upTo}/${days}` : ""}`
        : cur.kind === "standings"
          ? "Ceremonia"
          : (result.rounds[cur.roundIdx]?.name ?? "");

  return {
    cur,
    done,
    days,
    groupUpTo,
    // Live until the cuts stamp: the final matchday (upTo === days) ticks in
    // with its wash and dots like every other day; "Final" waits for groupDone.
    groupPhase: groupUpTo == null ? "hidden" : stamped ? "stamped" : "live",
    roundsShown,
    humanGames,
    clash,
    phaseLabel,
  };
}
