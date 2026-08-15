import {
  IS_LOCAL_DEV,
  RANKED_ACCEPT_MS,
  RANKED_COUNTDOWN_MS,
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
  type QueueServerMsg,
  type ReadyCheck,
} from "./protocol";

// ---------------------------------------------------------------------------
// The Queue policy module. Every matchmaking rule lives here, pure, exactly
// as the Directory keeps its policy in src/mp/directory.ts:
//
// - queueMembers derives membership from connection facts: one member per
//   account, arrival order.
// - queuePolicy is the whole matchmaking machine, reconciled on every event:
//   the fill countdown (enough players arms it, too few cancels it, late
//   joiners never reset it), the ready check it locks when it lands, and the
//   check's three exits — all accepted forms the match, a leaver dissolves
//   it, the deadline kicks whoever never accepted.
// - acceptCheck applies one member's accept to a stored check.
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
 *  result; this bounds a room that never does. Local dev shortens it to a
 *  minute — abandoned test matches must not lock accounts out for hours. */
export const ACTIVE_HOLD_TTL_MS = IS_LOCAL_DEV ? 60_000 : 3 * 60 * 60 * 1000;

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

export interface QueueFacts<T extends QueueMember = QueueMember> {
  members: T[];
  /** The fill countdown currently stored, or null when none is armed. */
  fillDeadline: number | null;
  /** The ready check currently stored, or null when none is live. */
  check: ReadyCheck | null;
  now: number;
}

export interface QueueDecision<T extends QueueMember = QueueMember> {
  /** What the stored fill countdown should now hold. */
  fillDeadline: number | null;
  /** What the stored check should now hold. The alarm slot follows whichever
   *  of the two deadlines exists (they are never both set). */
  check: ReadyCheck | null;
  /**
   * Everyone accepted: seat exactly these members, in queue order. When set,
   * sends is empty — the host births the room, delivers the match frames
   * itself, and reconciles again for whoever is still waiting.
   */
  match: T[] | null;
  /** userIds that sat out the ready check past its deadline. Their entry in
   *  sends is the kick notice; the host closes them after delivering it. */
  kicks: string[];
  /** One frame per member, parallel to facts.members. Ready frames carry
   *  image: null placeholders — avatars are the host's concern; it fills
   *  them in by index against check.userIds. */
  sends: QueueServerMsg[];
}

/**
 * The matchmaking machine, as one pure reconciliation:
 *
 * 1. A live check resolves first — all accepted forms the match, a missing
 *    member (leave = decline) dissolves it with nobody punished, a passed
 *    deadline dissolves it and kicks whoever never accepted. Accepted
 *    survivors keep their joinedAt, so they stay at the front of the line.
 * 2. With no live check, the fill rule runs over whoever remains: enough
 *    players and no countdown arms one, too few cancels it (places kept),
 *    joins during a countdown never reset it. When the countdown lands, the
 *    head of the queue — capped at a full room — locks into a fresh check.
 * 3. Everyone left over hears queue state. Members beyond a full room see no
 *    fill deadline: the lock cannot take them.
 */
export function queuePolicy<T extends QueueMember>({
  members,
  fillDeadline,
  check,
  now,
}: QueueFacts<T>): QueueDecision<T> {
  let fill = fillDeadline;
  let kicks: string[] = [];

  if (check) {
    const connected = new Set(members.map((m) => m.userId));
    const hasAccepted = new Set(check.accepted);
    if (!check.userIds.every((id) => connected.has(id))) {
      check = null;
    } else if (check.userIds.every((id) => hasAccepted.has(id))) {
      const byId = new Map(members.map((m) => [m.userId, m]));
      return {
        fillDeadline: null,
        check: null,
        match: check.userIds.map((id) => byId.get(id)!),
        kicks: [],
        sends: [],
      };
    } else if (now >= check.deadline) {
      kicks = check.userIds.filter((id) => !hasAccepted.has(id));
      check = null;
    }
  }

  const pool = members.filter((m) => !kicks.includes(m.userId));
  const locked = new Set(check?.userIds ?? []);
  const waiting = pool.filter((m) => !locked.has(m.userId));

  if (check) {
    fill = null; // a live check owns the clock
  } else {
    if (waiting.length >= RANKED_MIN_PLAYERS && fill == null) {
      fill = now + RANKED_COUNTDOWN_MS;
    } else if (waiting.length < RANKED_MIN_PLAYERS && fill != null) {
      fill = null;
    }
    if (fill != null && now >= fill) {
      check = {
        userIds: waiting.slice(0, RANKED_MAX_PLAYERS).map((m) => m.userId),
        accepted: [],
        deadline: now + RANKED_ACCEPT_MS,
      };
      locked.clear();
      for (const id of check.userIds) locked.add(id);
      fill = null;
    }
  }

  const waitingAfterLock = pool.filter((m) => !locked.has(m.userId));
  const positions = new Map(waitingAfterLock.map((m, i) => [m.userId, i + 1]));
  const sends = members.map<QueueServerMsg>((member) => {
    if (kicks.includes(member.userId)) {
      return {
        t: "error",
        code: "no-accept",
        msg: "Match declined — you didn't accept in time.",
      };
    }
    if (check && locked.has(member.userId)) {
      return {
        t: "ready",
        deadline: check.deadline,
        accepted: check.accepted.includes(member.userId),
        players: check.userIds.map((id) => ({
          accepted: check!.accepted.includes(id),
          image: null,
        })),
      };
    }
    const position = positions.get(member.userId)!;
    return {
      t: "queue",
      count: waitingAfterLock.length,
      position,
      // Beyond a full room the lock cannot take you — no false imminence.
      deadline: position <= RANKED_MAX_PLAYERS ? fill : null,
    };
  });

  return { fillDeadline: fill, check, match: null, kicks, sends };
}

/** Apply one member's accept. Returns the same reference when it changes
 *  nothing (not locked, already accepted, no live check) so the host can
 *  skip the storage write. */
export function acceptCheck(check: ReadyCheck | null, userId: string): ReadyCheck | null {
  if (!check || !check.userIds.includes(userId) || check.accepted.includes(userId)) return check;
  return { ...check, accepted: [...check.accepted, userId] };
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
