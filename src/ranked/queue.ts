import {
  RANKED_COUNTDOWN_MS,
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
  type QueueServerMsg,
} from "./protocol";

// ---------------------------------------------------------------------------
// The Queue policy module. Every matchmaking rule lives here, pure, exactly
// as the Directory keeps its policy in src/mp/directory.ts:
//
// - queueMembers derives membership from connection facts: one member per
//   account, arrival order.
// - queuePolicy is the countdown rule: enough players and no countdown
//   starts one, too few cancels it (places kept), late joiners never reset.
// - formMatch takes the head of the queue when the countdown lands.
// - holdVerdict and releasedHoldKeys govern "seated in a live match can't
//   queue": the hold, its TTL safety net, and its release.
//
// Presence is the one source of membership truth — the policy never stores
// anything. Sockets, storage, the alarm slot, and the room-init call stay in
// the queue host (worker/rankedQueue.ts).
// ---------------------------------------------------------------------------

export interface QueueMember {
  userId: string;
  name: string;
  joinedAt: number;
}

/** A matched member's block on re-queueing while their match is live. */
export interface ActiveHold {
  code: string;
  at: number;
}

/** Safety net for holds: they normally clear when the room records its
 *  result; this bounds a room that never does. */
export const ACTIVE_HOLD_TTL_MS = 3 * 60 * 60 * 1000;

/**
 * Membership from raw connection facts: one member per account (the oldest
 * connection wins a duplicate), in arrival order. Generic so the host can
 * carry its Connection through and know exactly whom to send to.
 */
export function queueMembers<T extends QueueMember>(entries: Iterable<T>): T[] {
  const byUser = new Map<string, T>();
  for (const entry of entries) {
    const existing = byUser.get(entry.userId);
    if (!existing || entry.joinedAt < existing.joinedAt) byUser.set(entry.userId, entry);
  }
  return [...byUser.values()].sort((a, b) => a.joinedAt - b.joinedAt);
}

export interface QueueFacts {
  members: QueueMember[];
  /** The countdown currently stored, or null when none is armed. */
  deadline: number | null;
  now: number;
}

export interface QueueDecision {
  /** What the stored countdown (and the alarm slot) should now hold. */
  deadline: number | null;
  /** One queue frame per member, parallel to facts.members. */
  sends: QueueServerMsg[];
}

/**
 * The queue's one rule: enough players and no countdown starts one, too few
 * cancels it (the remaining members keep their place), and everyone hears
 * the new state. Joins during a countdown never reset it.
 */
export function queuePolicy({ members, deadline, now }: QueueFacts): QueueDecision {
  let next = deadline;
  if (members.length >= RANKED_MIN_PLAYERS && next == null) {
    next = now + RANKED_COUNTDOWN_MS;
  } else if (members.length < RANKED_MIN_PLAYERS && next != null) {
    next = null;
  }
  const sends = members.map<QueueServerMsg>((_, index) => ({
    t: "queue",
    count: members.length,
    position: index + 1,
    deadline: next,
  }));
  return { deadline: next, sends };
}

/**
 * The countdown landed: the head of the queue forms the match, capped at a
 * full room. Null when too few remain — the members stay queued and
 * queuePolicy re-arms a fresh countdown.
 */
export function formMatch<T extends QueueMember>(members: T[]): T[] | null {
  return members.length >= RANKED_MIN_PLAYERS ? members.slice(0, RANKED_MAX_PLAYERS) : null;
}

export type HoldVerdict =
  /** The match is (or may still be) live — refuse the queue. */
  | "block"
  /** The TTL passed with no release — clear the hold and admit. */
  | "stale"
  /** No hold — admit. */
  | "none";

/** May this account queue, given its stored hold? */
export function holdVerdict(hold: ActiveHold | null | undefined, now: number): HoldVerdict {
  if (!hold) return "none";
  return now - hold.at < ACTIVE_HOLD_TTL_MS ? "block" : "stale";
}

/** Which stored holds a finished match's release frees. */
export function releasedHoldKeys(
  holds: Iterable<[string, ActiveHold]>,
  code: string,
): string[] {
  return [...holds].filter(([, hold]) => hold.code === code).map(([key]) => key);
}
