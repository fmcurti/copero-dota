import { describe, expect, it } from "vitest";
import {
  ACTIVE_HOLD_TTL_MS,
  acceptCheck,
  holdVerdict,
  queueMembers,
  queuePolicy,
  releasedHoldKeys,
  type QueueMember,
} from "./queue";
import {
  RANKED_ACCEPT_MS,
  RANKED_COUNTDOWN_MS,
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
  type ReadyCheck,
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

const ids = (n: number): string[] => lineup(n).map((m) => m.userId);

const checkOf = (userIds: string[], accepted: string[] = [], deadline = NOW + RANKED_ACCEPT_MS): ReadyCheck => ({
  userIds,
  accepted,
  deadline,
});

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

describe("the fill countdown", () => {
  it("stays unarmed below the minimum", () => {
    const { fillDeadline, check, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS - 1),
      fillDeadline: null,
      check: null,
      now: NOW,
    });
    expect(fillDeadline).toBeNull();
    expect(check).toBeNull();
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
    const { fillDeadline, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS),
      fillDeadline: null,
      check: null,
      now: NOW,
    });
    expect(fillDeadline).toBe(NOW + RANKED_COUNTDOWN_MS);
    for (const send of sends) {
      expect(send).toMatchObject({ t: "queue", deadline: NOW + RANKED_COUNTDOWN_MS });
    }
  });

  it("never resets a running countdown for a late joiner", () => {
    const armed = NOW + RANKED_COUNTDOWN_MS;
    const { fillDeadline } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS + 2),
      fillDeadline: armed,
      check: null,
      now: NOW + 7000,
    });
    expect(fillDeadline).toBe(armed);
  });

  it("cancels when the queue drops below the minimum — places kept", () => {
    const { fillDeadline, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS - 1),
      fillDeadline: NOW + RANKED_COUNTDOWN_MS,
      check: null,
      now: NOW + 3000,
    });
    expect(fillDeadline).toBeNull();
    expect(sends.map((s) => (s.t === "queue" ? s.position : -1))).toEqual([1, 2, 3]);
  });

  it("shows no deadline to members a full room cannot take", () => {
    const armed = NOW + RANKED_COUNTDOWN_MS;
    const { sends } = queuePolicy({
      members: lineup(RANKED_MAX_PLAYERS + 2),
      fillDeadline: armed,
      check: null,
      now: NOW + 1000,
    });
    expect(
      sends.map((s) => (s.t === "queue" ? s.deadline : "not-queue")),
    ).toEqual([
      ...Array.from({ length: RANKED_MAX_PLAYERS }, () => armed),
      null,
      null,
    ]);
  });
});

describe("locking the ready check", () => {
  it("locks the head of the queue, capped at a full room, when the fill lands", () => {
    const { fillDeadline, check, sends, match } = queuePolicy({
      members: lineup(RANKED_MAX_PLAYERS + 2),
      fillDeadline: NOW,
      check: null,
      now: NOW,
    });
    expect(match).toBeNull();
    expect(fillDeadline).toBeNull();
    expect(check).toEqual({
      userIds: ids(RANKED_MAX_PLAYERS),
      accepted: [],
      deadline: NOW + RANKED_ACCEPT_MS,
    });
    // The locked hear the ready call; the two left over queue at the front.
    for (const send of sends.slice(0, RANKED_MAX_PLAYERS)) {
      expect(send).toEqual({
        t: "ready",
        deadline: NOW + RANKED_ACCEPT_MS,
        accepted: false,
        players: ids(RANKED_MAX_PLAYERS).map(() => ({ accepted: false, image: null })),
      });
    }
    expect(sends.slice(RANKED_MAX_PLAYERS)).toEqual([
      { t: "queue", count: 2, position: 1, deadline: null },
      { t: "queue", count: 2, position: 2, deadline: null },
    ]);
  });

  it("a live check owns the clock — no fill runs alongside it", () => {
    const { fillDeadline, check } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS * 2),
      fillDeadline: null,
      check: checkOf(ids(RANKED_MIN_PLAYERS)),
      now: NOW,
    });
    expect(fillDeadline).toBeNull();
    expect(check).toEqual(checkOf(ids(RANKED_MIN_PLAYERS)));
  });
});

describe("accepting", () => {
  it("applies a locked member's accept exactly once, and nobody else's", () => {
    const check = checkOf(ids(RANKED_MIN_PLAYERS));
    const once = acceptCheck(check, "u1");
    expect(once?.accepted).toEqual(["u1"]);
    expect(acceptCheck(once, "u1")).toBe(once);
    expect(acceptCheck(check, "stranger")).toBe(check);
    expect(acceptCheck(null, "u1")).toBeNull();
  });

  it("broadcasts every accept to the whole check — each hears their own state", () => {
    const { sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS),
      fillDeadline: null,
      check: checkOf(ids(RANKED_MIN_PLAYERS), ["u1", "u2"]),
      now: NOW,
    });
    const players = ids(RANKED_MIN_PLAYERS).map((id) => ({
      accepted: id === "u1" || id === "u2",
      image: null,
    }));
    expect(sends.map((s) => (s.t === "ready" ? s.accepted : "not-ready"))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    for (const send of sends) expect(send).toMatchObject({ t: "ready", players });
  });

  it("everyone accepted: the match is exactly the locked roster, in order", () => {
    const members = lineup(RANKED_MIN_PLAYERS + 1);
    const { match, check, fillDeadline, kicks, sends } = queuePolicy({
      members,
      fillDeadline: null,
      check: checkOf(ids(RANKED_MIN_PLAYERS), ids(RANKED_MIN_PLAYERS)),
      now: NOW,
    });
    expect(match?.map((m) => m.userId)).toEqual(ids(RANKED_MIN_PLAYERS));
    expect(check).toBeNull();
    expect(fillDeadline).toBeNull();
    expect(kicks).toEqual([]);
    // The host births the room and reconciles again for the one left waiting.
    expect(sends).toEqual([]);
  });
});

describe("a check dissolving", () => {
  it("a leaver (decline) dissolves it — survivors re-fill and see the red slot", () => {
    // u1 closed their socket mid-check; the rest are still enough to re-arm.
    // u4 was never locked — no red squares for them.
    const members = lineup(RANKED_MIN_PLAYERS + 1).filter((m) => m.userId !== "u1");
    const { check, fillDeadline, kicks, dissolvedCheck, sends } = queuePolicy({
      members,
      fillDeadline: null,
      check: checkOf(ids(RANKED_MIN_PLAYERS), ["u0", "u2"]),
      now: NOW + 5000,
    });
    expect(check).toBeNull();
    expect(kicks).toEqual([]);
    expect(dissolvedCheck).toEqual(checkOf(ids(RANKED_MIN_PLAYERS), ["u0", "u2"]));
    expect(fillDeadline).toBe(NOW + 5000 + RANKED_COUNTDOWN_MS);
    const dissolved = {
      players: [
        { accepted: true, image: null },
        { accepted: false, image: null },
        { accepted: true, image: null },
        { accepted: false, image: null },
      ],
      failed: [1],
    };
    // members order: u0, u2, u3 (locked survivors), u4 (was only waiting).
    expect(sends.map((s) => (s.t === "queue" ? s.dissolved : "not-queue"))).toEqual([
      dissolved,
      dissolved,
      dissolved,
      undefined,
    ]);
  });

  it("the deadline kicks whoever never accepted; the accepted keep the front", () => {
    const locked = ids(RANKED_MIN_PLAYERS + 2);
    const accepted = locked.slice(0, RANKED_MIN_PLAYERS);
    const deadline = NOW + RANKED_ACCEPT_MS;
    const { check, fillDeadline, kicks, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS + 2),
      fillDeadline: null,
      check: checkOf(locked, accepted, deadline),
      now: deadline,
    });
    expect(check).toBeNull();
    expect(kicks).toEqual(locked.slice(RANKED_MIN_PLAYERS));
    // Enough sat through it that a fresh countdown arms for them at once.
    expect(fillDeadline).toBe(deadline + RANKED_COUNTDOWN_MS);
    expect(sends.slice(0, RANKED_MIN_PLAYERS)).toEqual(
      accepted.map((_, i) => ({
        t: "queue",
        count: RANKED_MIN_PLAYERS,
        position: i + 1,
        deadline: deadline + RANKED_COUNTDOWN_MS,
        // The kicked pair are the red squares of the echo.
        dissolved: {
          players: locked.map((id) => ({ accepted: accepted.includes(id), image: null })),
          failed: [RANKED_MIN_PLAYERS, RANKED_MIN_PLAYERS + 1],
        },
      })),
    );
    for (const send of sends.slice(RANKED_MIN_PLAYERS)) {
      expect(send).toMatchObject({ t: "error", code: "no-accept" });
    }
  });

  it("too few survivors after a kick: no countdown, places kept", () => {
    const locked = ids(RANKED_MIN_PLAYERS);
    const deadline = NOW + RANKED_ACCEPT_MS;
    const { fillDeadline, kicks, sends } = queuePolicy({
      members: lineup(RANKED_MIN_PLAYERS),
      fillDeadline: null,
      check: checkOf(locked, ["u0"], deadline),
      now: deadline + 1,
    });
    expect(kicks).toEqual(locked.slice(1));
    expect(fillDeadline).toBeNull();
    expect(sends[0]).toMatchObject({ t: "queue", count: 1, position: 1, deadline: null });
    expect(sends[0].t === "queue" && sends[0].dissolved?.failed).toEqual([1, 2, 3]);
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
