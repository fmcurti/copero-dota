import {
  DEFAULT_MP_CONFIG,
  MAX_SEATS,
  isId,
  isRecord,
  makeRoomCode,
  type MpConfig,
} from "../mp/protocol";
import { RANKED_MIN_PLAYERS as RANKED_MIN_BASE } from "./rating";

// ---------------------------------------------------------------------------
// The ranked vocabulary shared by the queue, the ranked room, and the hub
// page: match-formation constants, the one fixed ranked ruleset, and the
// queue's wire protocol. Everything rated is decided in docs/RANKED.md.
// ---------------------------------------------------------------------------

/**
 * Local dev runs the queue at 2 players so one person with two browser tabs
 * can exercise the whole ready-check flow. Vitest (MODE "test") and
 * production builds keep the real minimum — and the worker and the client are
 * both Vite environments, so the two sides of the seam always agree.
 */
const viteEnv = (import.meta as { env?: { DEV?: boolean; MODE?: string } }).env;
export const RANKED_MIN_PLAYERS =
  viteEnv?.DEV && viteEnv.MODE !== "test" ? 2 : RANKED_MIN_BASE;
/** Late queue joiners fill toward a full room during the countdown. */
export const RANKED_MAX_PLAYERS = MAX_SEATS;
/** The countdown once the queue holds a match's worth of players. */
export const RANKED_COUNTDOWN_MS = 10_000;
/** The ready check's accept window. Longer than Dota's: a browser tab may be
 *  hidden, and the horn + notification need time to pull the player back. */
export const RANKED_ACCEPT_MS = 15_000;
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

export interface RankedQueueStatus {
  count: number;
  deadline: number | null;
}

// ---- the ready check ----

/**
 * The Dota moment: the fill countdown lands and the head of the queue is
 * locked into a ready check. Everyone locked must accept before the deadline
 * or the check dissolves — the roster is all-or-nothing, never partial.
 */
export interface ReadyCheck {
  /** The locked roster, in queue order. */
  userIds: string[];
  /** Who has accepted so far — a subset of userIds. */
  accepted: string[];
  /** The accept window's epoch-ms deadline. */
  deadline: number;
}

/** One slot of the "waiting for players" grid — anonymous besides the avatar. */
export interface ReadySlot {
  accepted: boolean;
  image: string | null;
}

// ---- the queue's wire protocol ----
// Presence IS the message: joining the socket joins the queue, closing it
// leaves — closing during a ready check is how a match is declined. The one
// frame a client ever sends is the accept.

export type QueueServerMsg =
  /** Queue state for this member. `deadline` is the fill countdown's epoch ms. */
  | { t: "queue"; count: number; position: number; deadline: number | null }
  /** You are locked in a ready check. `accepted` is your own state; `players`
   *  is the whole roster in queue order, anonymized to accept + avatar. */
  | { t: "ready"; deadline: number; accepted: boolean; players: ReadySlot[] }
  /** A match formed and you are in it — connect to the ranked room. */
  | { t: "match"; code: string }
  /** Always terminal: the server closes the socket right after sending one,
   *  so the client treats the frame itself as the goodbye. */
  | { t: "error"; code: string; msg: string };

export type QueueClientMsg = { t: "accept" };

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
  if (value.t === "ready") {
    if (!isId(value.deadline) || typeof value.accepted !== "boolean") return null;
    if (!Array.isArray(value.players)) return null;
    const players: ReadySlot[] = [];
    for (const slot of value.players as unknown[]) {
      if (!isRecord(slot) || typeof slot.accepted !== "boolean") return null;
      if (slot.image !== null && typeof slot.image !== "string") return null;
      players.push({ accepted: slot.accepted, image: slot.image });
    }
    return { t: "ready", deadline: value.deadline, accepted: value.accepted, players };
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

/** Validate the one client frame (server side of the same seam). */
export function parseQueueClientMsg(value: unknown): QueueClientMsg | null {
  return isRecord(value) && value.t === "accept" ? { t: "accept" } : null;
}
