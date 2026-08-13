import { DEFAULT_MP_CONFIG, type MpConfig } from "../mp/protocol";
import { RANKED_MIN_PLAYERS } from "./rating";

// ---------------------------------------------------------------------------
// The ranked vocabulary shared by the queue, the ranked room, and the hub
// page: match-formation constants, the one fixed ranked ruleset, and the
// queue's wire protocol. Everything rated is decided in docs/RANKED.md.
// ---------------------------------------------------------------------------

export { RANKED_MIN_PLAYERS };
/** Rooms seat up to 8; late queue joiners fill toward this during countdown. */
export const RANKED_MAX_PLAYERS = 8;
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
export function makeRankedCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Validate an untrusted decoded queue frame at the protocol seam. */
export function parseQueueServerMsg(value: unknown): QueueServerMsg | null {
  if (!isRecord(value)) return null;
  if (value.t === "queue") {
    return isStamp(value.count) &&
      isStamp(value.position) &&
      (value.deadline === null || isStamp(value.deadline))
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
