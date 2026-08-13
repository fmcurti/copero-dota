import {
  DEFAULT_MP_CONFIG,
  MAX_SEATS,
  isId,
  isRecord,
  makeRoomCode,
  type MpConfig,
} from "../mp/protocol";
import { RANKED_MIN_PLAYERS } from "./rating";

// ---------------------------------------------------------------------------
// The ranked vocabulary shared by the queue, the ranked room, and the hub
// page: match-formation constants, the one fixed ranked ruleset, and the
// queue's wire protocol. Everything rated is decided in docs/RANKED.md.
// ---------------------------------------------------------------------------

export { RANKED_MIN_PLAYERS };
/** Late queue joiners fill toward a full room during the countdown. */
export const RANKED_MAX_PLAYERS = MAX_SEATS;
/** The countdown once the queue holds a match's worth of players. */
export const RANKED_COUNTDOWN_MS = 10_000;
/** How long a formed room waits in its lobby before the draft auto-starts. */
export const RANKED_START_GRACE_MS = 45_000;
/** Once every seat is connected, the remaining lobby wait shrinks to this. */
export const RANKED_ALL_CONNECTED_MS = 5_000;
/** Pause on the assembled screen before the broadcast auto-plays. */
export const RANKED_PLAY_GRACE_MS = 15_000;
export const RANKED_SEASON = 1;

/**
 * The one ranked ruleset — no host exists to configure anything. Defaults,
 * except per-event OVRs, and spectatable so finished lobbies appear on the
 * watch tab once the draft starts (never as joinable).
 */
export const RANKED_CONFIG: MpConfig = {
  ...DEFAULT_MP_CONFIG,
  cardMode: "event",
  visibility: "spectatable",
};

/**
 * Ranked room codes are 8 chars (casual uses 5): the code doubles as the
 * eternal ranked_match primary key, so the space must be collision-proof
 * across the ladder's lifetime, not just across live rooms.
 */
export const makeRankedCode = (): string => makeRoomCode(8);

// ---- the read API's row shapes ----
// Declared once here so the worker endpoints and the hub page share one wire
// contract instead of drifting copies.

export interface LeaderboardRow {
  userId: string;
  name: string;
  image: string | null;
  rating: number;
  gamesPlayed: number;
}

export interface RankedProfile {
  rating: number;
  gamesPlayed: number;
  /** 1-based ladder position, or null before the first ranked game. */
  rank: number | null;
}

/** One player's line of a recorded match (`ranked_match_player`). */
export interface RankedMatchPlayerRow {
  userId: string;
  teamName: string;
  place: number;
  gamesWon: number;
  ratingBefore: number;
  ratingExchange: number;
  ratingBonus: number;
  ratingAfter: number;
}

export interface RankedHistoryRow extends RankedMatchPlayerRow {
  matchId: string;
  completedAt: number;
  players: number;
}

/** Everything the hub page shows, in one response. */
export interface RankedHub {
  season: number;
  leaderboard: LeaderboardRow[];
  /** Null when the caller has no session. */
  me: RankedProfile | null;
  history: RankedHistoryRow[] | null;
}

// ---- the queue's wire protocol ----
// Presence IS the message: joining the socket joins the queue, closing it
// leaves. The server pushes state; the client never sends anything.

export type QueueServerMsg =
  /** Queue state for this member. `deadline` is the countdown's epoch ms. */
  | { t: "queue"; count: number; position: number; deadline: number | null }
  /** A match formed and you are in it — connect to the ranked room. */
  | { t: "match"; code: string }
  | { t: "error"; code: string; msg: string };

/** Validate an untrusted decoded queue frame at the protocol seam. */
export function parseQueueServerMsg(value: unknown): QueueServerMsg | null {
  if (!isRecord(value)) return null;
  if (value.t === "queue") {
    return isId(value.count) &&
      isId(value.position) &&
      (value.deadline === null || isId(value.deadline))
      ? { t: "queue", count: value.count, position: value.position, deadline: value.deadline }
      : null;
  }
  if (value.t === "match") {
    return typeof value.code === "string" ? { t: "match", code: value.code } : null;
  }
  if (value.t === "error") {
    return typeof value.code === "string" && typeof value.msg === "string"
      ? { t: "error", code: value.code, msg: value.msg }
      : null;
  }
  return null;
}
