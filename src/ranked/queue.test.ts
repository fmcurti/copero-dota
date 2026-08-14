import { describe, expect, it } from "vitest";
import {
  ACTIVE_HOLD_TTL_MS,
  formMatch,
  holdVerdict,
  queueMembers,
  queuePolicy,
  releasedHoldKeys,
  type QueueMember,
} from "./queue";
import {
  RANKED_COUNTDOWN_MS,
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
} from "./protocol";

const NOW = 1_700_000_000_000;

const member = (userId: string, joinedAt: number, name = userId): QueueMember => ({
  userId,
  name,
  joinedAt,
});

/** n members joined a second apart, oldest first. */
const lineup = (n: number): QueueMember[] =>
  Array.from({ length: n }, (_, i) => member(`u${i}`, NOW + i * 1000));

describe("queue membership", () => {
  it("keeps one member per account — the oldest connection wins", () => {
    const members = queueMembers([
      member("a", NOW + 2000),
      member("b", NOW),
      member("a", NOW + 5000),
    ]);
    expect(members.map((m) => [m.userId, m.joinedAt])).toEqual([
      ["b", NOW],
      ["a", NOW + 2000],
    ]);
  });

  it("orders by arrival and carries extra fields through", () => {
    const withConn = queueMembers([
      { ...member("late", NOW + 9000), conn: "c1" },
      { ...member("early", NOW), conn: "c2" },
    ]);
    expect(withConn.map((m) => m.conn)).toEqual(["c2", "c1"]);
  });
});

describe("the countdown rule", () => {
  it("stays unarmed below the minimum", () => {
    const { deadline, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS - 1),
      deadline: null,
      now: NOW,
    });
    expect(deadline).toBeNull();
    expect(sends).toEqual(
      lineup(RANKED_MIN_PLAYERS - 1).map((_, i) => ({
        t: "queue",
        count: RANKED_MIN_PLAYERS - 1,
        position: i + 1,
        deadline: null,
      })),
    );
  });

  it("arms at the minimum and tells everyone", () => {
    const { deadline, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS),
      deadline: null,
      now: NOW,
    });
    expect(deadline).toBe(NOW + RANKED_COUNTDOWN_MS);
    for (const send of sends) {
      expect(send).toMatchObject({ t: "queue", deadline: NOW + RANKED_COUNTDOWN_MS });
    }
  });

  it("never resets a running countdown for a late joiner", () => {
    const armed = NOW + RANKED_COUNTDOWN_MS;
    const { deadline } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS + 2),
      deadline: armed,
      now: NOW + 7000,
    });
    expect(deadline).toBe(armed);
  });

  it("cancels when the queue drops below the minimum — places kept", () => {
    const { deadline, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS - 1),
      deadline: NOW + RANKED_COUNTDOWN_MS,
      now: NOW + 3000,
    });
    expect(deadline).toBeNull();
    expect(sends.map((s) => (s.t === "queue" ? s.position : -1))).toEqual([1, 2, 3]);
  });
});

describe("match formation", () => {
  it("refuses below the minimum — the members stay queued", () => {
    expect(formMatch(lineup(RANKED_MIN_PLAYERS - 1))).toBeNull();
  });

  it("forms exactly at the minimum", () => {
    const matched = formMatch(lineup(RANKED_MIN_PLAYERS));
    expect(matched?.map((m) => m.userId)).toEqual(
      lineup(RANKED_MIN_PLAYERS).map((m) => m.userId),
    );
  });

  it("takes the head of the queue, capped at a full room", () => {
    const matched = formMatch(lineup(RANKED_MAX_PLAYERS + 3));
    expect(matched).toHaveLength(RANKED_MAX_PLAYERS);
    expect(matched?.[0].userId).toBe("u0");
    expect(matched?.at(-1)?.userId).toBe(`u${RANKED_MAX_PLAYERS - 1}`);
  });
});

describe("active holds", () => {
  it("admits with no hold, blocks a live one, clears a stale one", () => {
    expect(holdVerdict(null, NOW)).toBe("none");
    expect(holdVerdict(undefined, NOW)).toBe("none");
    expect(holdVerdict({ code: "AAAA2222", at: NOW - 1 }, NOW)).toBe("block");
    expect(holdVerdict({ code: "AAAA2222", at: NOW - ACTIVE_HOLD_TTL_MS + 1 }, NOW)).toBe("block");
    expect(holdVerdict({ code: "AAAA2222", at: NOW - ACTIVE_HOLD_TTL_MS }, NOW)).toBe("stale");
  });

  it("a release frees exactly the finished match's holds", () => {
    const holds: [string, { code: string; at: number }][] = [
      ["active:a", { code: "AAAA2222", at: NOW }],
      ["active:b", { code: "BBBB3333", at: NOW }],
      ["active:c", { code: "AAAA2222", at: NOW }],
    ];
    expect(releasedHoldKeys(holds, "AAAA2222")).toEqual(["active:a", "active:c"]);
    expect(releasedHoldKeys(holds, "ZZZZ9999")).toEqual([]);
  });
});
