import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardPool } from "../game/cards";
import { emptySlots, isComplete, materialize, SLOT_IDS } from "../game/draft";
import { mulberry32, type Rng } from "../game/rng";
import { autopick } from "./autopick";
import {
  activePackIndex,
  applyAction,
  boardComplete,
  createDraft,
  dealTurbo,
  legalActions,
  openSpread,
  packHolder,
  packsPerSpread,
  type Board,
  type CardRef,
  type EngineState,
} from "./engine";
import type { DataBundle, Pack, PackPlayer, Role } from "../game/types";

// ---------------------------------------------------------------------------
// Synthetic pool helpers
// ---------------------------------------------------------------------------

const FULL_ROLES: Role[] = ["safelane", "mid", "offlane", "support", "support"];

function makePlayer(steamId: number, role: Role, ovr = 80): PackPlayer {
  return {
    steamId,
    nickname: `p${steamId}`,
    role,
    ovr,
    impact: 70,
    economy: 70,
    reliability: 70,
    games: 50,
  };
}

/** A pack with 5 players of the given roles and exactly 5 signature heroes. */
function makePack(id: number, roles: Role[] = FULL_ROLES, heroBase = 0): Pack {
  return {
    id: `pk${id}`,
    eventId: "ev1",
    teamId: id,
    teamName: `Team ${id}`,
    tag: `T${id}`,
    logoId: "",
    placement: 1,
    players: roles.map((r, i) => makePlayer(id * 100 + i, r)),
    signatureHeroes: [heroBase + 1, heroBase + 2, heroBase + 3, heroBase + 4, heroBase + 5],
  };
}

/** Pool with distinct players and distinct heroes per pack — plenty to finish any draft. */
function makePool(n = 40): Pack[] {
  return Array.from({ length: n }, (_, i) => makePack(i + 1, FULL_ROLES, (i + 1) * 10));
}

function board(partial: Partial<Record<(typeof SLOT_IDS)[number], PackPlayer>>, heroes: number[] = []): Board {
  return { slots: { ...emptySlots(), ...partial }, heroes };
}

function legalPicksOf(s: EngineState) {
  return legalActions(s, s.turnSeat!).picks;
}

/** Play a full draft: every turn takes the given strategy's action. */
function runDraft(
  s: EngineState,
  pool: Pack[],
  rng: () => number,
  act: (s: EngineState, seat: number) => ReturnType<typeof applyAction>,
): EngineState {
  let guard = 0;
  while (!s.done) {
    if (++guard > 6000) throw new Error("draft did not terminate");
    if (!s.currentPacks.length) {
      s = openSpread(s, pool, rng);
      continue;
    }
    const seat = s.turnSeat;
    if (seat == null) throw new Error("open spread but no turn");
    const r = act(s, seat);
    if (r.error) throw new Error(`action failed: ${r.error}`);
    s = r.state;
  }
  return s;
}

function expectValidBoards(s: EngineState) {
  const seen = new Set<number>();
  for (const b of s.boards) {
    expect(boardComplete(b)).toBe(true);
    expect(new Set(b.heroes).size).toBe(5);
    for (const slot of SLOT_IDS) {
      const p = b.slots[slot]!;
      expect(seen.has(p.steamId)).toBe(false);
      seen.add(p.steamId);
      if (slot === "support1" || slot === "support2") expect(p.role).toBe("support");
      else expect(p.role).toBe(slot);
    }
  }
}

// ---------------------------------------------------------------------------

describe("engine basics", () => {
  it("opens a spread and gives the opener the first turn", () => {
    const s = openSpread(createDraft(3, { mulligans: 1 }), makePool(), mulberry32(1));
    expect(s.currentPacks).toHaveLength(1);
    expect(s.packSeq).toBe(1);
    expect(s.roundSeq).toBe(1);
    expect(s.turnSeat).toBe(0);
    expect(s.usedPackIds).toHaveLength(1);
  });

  it("starts on the seat the caller draws, and rotates from there", () => {
    expect(createDraft(4, { mulligans: 1 }).openerSeat).toBe(0); // default unchanged
    for (const seat of [0, 1, 2, 3]) {
      expect(createDraft(4, { mulligans: 1, openerSeat: seat }).openerSeat).toBe(seat);
    }
    // out-of-range rolls wrap rather than producing an unreachable seat
    expect(createDraft(3, { mulligans: 1, openerSeat: 5 }).openerSeat).toBe(2);
    expect(createDraft(3, { mulligans: 1, openerSeat: -1 }).openerSeat).toBe(2);

    // a non-zero start still gives that seat the first turn, then wraps in order
    let s = openSpread(createDraft(3, { mulligans: 1, openerSeat: 2 }), makePool(), mulberry32(7));
    for (const expected of [2, 0, 1]) {
      expect(s.turnSeat).toBe(expected);
      s = applyAction(s, s.turnSeat!, { type: "pick", card: legalActions(s, s.turnSeat!).picks[0] }).state;
    }
    // spread exhausted → opener advances off the drawn seat, not off seat 0
    s = openSpread(s, makePool(), mulberry32(8));
    expect(s.openerSeat).toBe(0);
  });

  it("rotates the turn around the table, then discards the spread and rotates the opener", () => {
    let s = openSpread(createDraft(3, { mulligans: 1 }), makePool(), mulberry32(2));
    for (const expected of [0, 1, 2]) {
      expect(s.turnSeat).toBe(expected);
      const pick = legalActions(s, expected).picks[0];
      s = applyAction(s, expected, { type: "pick", card: pick }).state;
    }
    expect(s.currentPacks).toHaveLength(0);
    expect(s.turnSeat).toBeNull();
    expect(s.openerSeat).toBe(1);
  });

  it("rejects out-of-turn actions and illegal picks", () => {
    const pool = makePool();
    const s = openSpread(createDraft(2, { mulligans: 1 }), pool, mulberry32(3));
    expect(applyAction(s, 1, { type: "pick", card: legalActions(s, 0).picks[0] }).error).toBe(
      "not-your-turn",
    );
    expect(
      applyAction(s, 0, { type: "pick", card: { kind: "player", steamId: 999999 } }).error,
    ).toBe("illegal-pick");
    expect(applyAction(s, 0, { type: "pass" }).error).toBe("cannot-pass");
  });

  it("players are exclusive: a drafted steamId is illegal for everyone after", () => {
    // Two packs sharing one player.
    const shared = makePlayer(7777, "mid", 90);
    const pA: Pack = { ...makePack(1, FULL_ROLES, 10), players: [...makePack(1).players.slice(0, 4)].concat(shared) };
    const p2 = makePack(2, FULL_ROLES, 20);
    const pB: Pack = { ...p2, players: p2.players.map((p) => (p.role === "mid" ? shared : p)) };
    expect(pA.players.some((p) => p.steamId === 7777)).toBe(true);

    let s = createDraft(2, { mulligans: 0 });
    s = openSpread(s, [pA], mulberry32(4));
    s = applyAction(s, 0, { type: "pick", card: { kind: "player", steamId: 7777 } }).state;
    s = applyAction(s, 1, { type: "pick", card: legalActions(s, 1).picks[0] }).state;
    s = openSpread(s, [pB], mulberry32(5));
    const picks = legalActions(s, s.turnSeat!).picks;
    expect(picks.some((c) => c.kind === "player" && c.steamId === 7777)).toBe(false);
  });
});

describe("double spread (5+ seats)", () => {
  it("packsPerSpread: 1 for 2-4 seats, 2 for 5-8", () => {
    expect(packsPerSpread(2)).toBe(1);
    expect(packsPerSpread(4)).toBe(1);
    expect(packsPerSpread(5)).toBe(2);
    expect(packsPerSpread(8)).toBe(2);
  });

  it("opens two packs with no shared players and no duplicate displayed heroes", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const s = openSpread(createDraft(6, { mulligans: 1 }), makePool(60), mulberry32(seed));
      expect(s.currentPacks).toHaveLength(2);
      expect(s.packSeq).toBe(2);
      expect(s.roundSeq).toBe(1);
      const [a, b] = s.currentPacks;
      const idsA = new Set(a.players.map((p) => p.steamId));
      expect(b.players.some((p) => idsA.has(p.steamId))).toBe(false);
      const heroes = [...a.heroes, ...b.heroes];
      expect(new Set(heroes).size).toBe(heroes.length);
    }
  });

  it("a pick from the second pack removes it there and nowhere else", () => {
    let s = openSpread(createDraft(6, { mulligans: 0 }), makePool(60), mulberry32(9));
    const target = s.currentPacks[1].players[0];
    s = applyAction(s, 0, { type: "pick", card: { kind: "player", steamId: target.steamId } }).state;
    expect(s.currentPacks[1].players.some((p) => p.steamId === target.steamId)).toBe(false);
    expect(s.currentPacks[0].players).toHaveLength(5);
    expect(s.boards[0].slots[target.role === "support" ? "support1" : target.role]?.steamId).toBe(
      target.steamId,
    );
  });

  it("mulligan burns the whole spread; replacement is a fresh two packs", () => {
    const pool = makePool(60);
    let s = openSpread(createDraft(5, { mulligans: 1 }), pool, mulberry32(11));
    const burned = s.currentPacks.map((p) => p.id);
    s = applyAction(s, 0, { type: "mulligan" }).state;
    expect(s.currentPacks).toHaveLength(0);
    s = openSpread(s, pool, mulberry32(12));
    expect(s.currentPacks).toHaveLength(2);
    expect(s.openerSeat).toBe(0);
    for (const id of burned) {
      expect(s.usedPackIds).toContain(id);
      expect(s.currentPacks.some((p) => p.id === id)).toBe(false);
    }
  });
});

describe("deny", () => {
  it("denied player is destroyed globally, consumes the action and a deny", () => {
    const pool = makePool();
    let s = openSpread(createDraft(2, { mulligans: 0 }), pool, mulberry32(6));
    const victim = s.currentPacks[0].players[0];
    s = applyAction(s, 0, { type: "deny", card: { kind: "player", steamId: victim.steamId } }).state;
    expect(s.deniesLeft[0]).toBe(0);
    expect(s.takenSteamIds).toContain(victim.steamId);
    expect(s.deniedShelf).toHaveLength(1);
    expect(s.deniedShelf[0].bySeat).toBe(0);
    expect(s.currentPacks[0].players.some((p) => p.steamId === victim.steamId)).toBe(false);
    expect(s.turnSeat).toBe(1); // action consumed, turn moved on
  });

  it("denied hero only leaves this pack — it can be drafted from a later spread", () => {
    const pA = { ...makePack(1, FULL_ROLES, 0), signatureHeroes: [42, 43, 44, 45, 46] };
    const pB = { ...makePack(2, FULL_ROLES, 0), signatureHeroes: [42, 53, 54, 55, 56] };
    let s = createDraft(2, { mulligans: 0 });
    s = openSpread(s, [pA], mulberry32(7));
    s = applyAction(s, 0, { type: "deny", card: { kind: "hero", heroId: 42 } }).state;
    expect(s.currentPacks[0].heroes).not.toContain(42);
    s = applyAction(s, 1, { type: "pick", card: legalActions(s, 1).picks[0] }).state;
    s = openSpread(s, [pB], mulberry32(8));
    const picks = legalPicksOf(s);
    expect(picks.some((c) => c.kind === "hero" && c.heroId === 42)).toBe(true);
  });

  it("cannot deny with no denies left", () => {
    const pool = makePool();
    let s = openSpread(createDraft(2, { mulligans: 0 }), pool, mulberry32(9));
    s.deniesLeft = [0, 0];
    const card = { kind: "player" as const, steamId: s.currentPacks[0].players[0].steamId };
    expect(applyAction(s, 0, { type: "deny", card }).error).toBe("cannot-deny");
  });
});

describe("mulligan", () => {
  it("opener may mulligan before acting: replacement spread, same opener, one mulligan spent", () => {
    const pool = makePool();
    let s = openSpread(createDraft(3, { mulligans: 1 }), pool, mulberry32(10));
    const burned = s.currentPacks[0].id;
    expect(legalActions(s, 0).canMulligan).toBe(true);
    s = applyAction(s, 0, { type: "mulligan" }).state;
    expect(s.mulligansLeft[0]).toBe(0);
    expect(s.currentPacks).toHaveLength(0);
    s = openSpread(s, pool, mulberry32(11));
    expect(s.openerSeat).toBe(0); // same opener re-opens
    expect(s.currentPacks[0].id).not.toBe(burned); // burned pack is used up
    expect(s.usedPackIds).toContain(burned);
  });

  it("non-openers cannot mulligan; opener cannot after acting", () => {
    const pool = makePool();
    let s = openSpread(createDraft(2, { mulligans: 2 }), pool, mulberry32(12));
    expect(legalActions(s, 1).canMulligan).toBe(false);
    expect(applyAction(s, 1, { type: "mulligan" }).error).toBe("illegal-mulligan");
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s)[0] }).state;
    expect(legalActions(s, 0).canMulligan).toBe(false);
  });
});

describe("skips and passes", () => {
  it("a seat with no legal pick and no deny left is auto-passed", () => {
    const pack = makePack(1, ["safelane", "safelane", "safelane", "safelane", "safelane"], 10);
    let s = createDraft(2, { mulligans: 0 });
    s.boards[1] = board(
      {
        safelane: makePlayer(9001, "safelane"),
        offlane: makePlayer(9002, "offlane"),
        support1: makePlayer(9003, "support"),
        support2: makePlayer(9004, "support"),
      },
      [11, 12, 13, 14, 15], // exactly the pack's signature heroes → none pickable
    );
    s.takenSteamIds = [9001, 9002, 9003, 9004];
    s.deniesLeft = [1, 0];
    s = openSpread(s, [pack], mulberry32(13));
    expect(s.turnSeat).toBe(0);
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s)[0] }).state;
    // seat 1 was auto-passed: spread over, no error state
    expect(s.currentPacks).toHaveLength(0);
    expect(s.turnSeat).toBeNull();
  });

  it("a seat with no legal pick but a deny left gets the turn and may deny or pass", () => {
    const pack = makePack(1, ["safelane", "safelane", "safelane", "safelane", "safelane"], 10);
    let s = createDraft(2, { mulligans: 0 });
    s.boards[1] = board(
      {
        safelane: makePlayer(9001, "safelane"),
        offlane: makePlayer(9002, "offlane"),
        support1: makePlayer(9003, "support"),
        support2: makePlayer(9004, "support"),
      },
      [11, 12, 13, 14, 15],
    );
    s.takenSteamIds = [9001, 9002, 9003, 9004];
    s = openSpread(s, [pack], mulberry32(14));
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s)[0] }).state;
    expect(s.turnSeat).toBe(1);
    const legal = legalActions(s, 1);
    expect(legal.picks).toHaveLength(0);
    expect(legal.canDeny).toBe(true);
    expect(legal.canPass).toBe(true);
    s = applyAction(s, 1, { type: "pass" }).state;
    expect(s.currentPacks).toHaveLength(0);
  });

  it("completed boards are skipped entirely and the draft finishes", () => {
    let s = createDraft(2, { mulligans: 0 });
    s.boards[1] = board(
      {
        safelane: makePlayer(9001, "safelane"),
        mid: makePlayer(9005, "mid"),
        offlane: makePlayer(9002, "offlane"),
        support1: makePlayer(9003, "support"),
        support2: makePlayer(9004, "support"),
      },
      [901, 902, 903, 904, 905],
    );
    s.takenSteamIds = [9001, 9002, 9003, 9004, 9005];
    const rng = mulberry32(15);
    const done = runDraft(s, makePool(), rng, (st, seat) => {
      expect(seat).toBe(0); // seat 1 must never act
      return applyAction(st, seat, { type: "pick", card: legalPicksOf(st)[0] });
    });
    expect(done.done).toBe(true);
    expectValidBoards(done);
  });
});

describe("full drafts", () => {
  it("greedy drafts complete with legal boards at every table size", () => {
    for (const seats of [2, 3, 4, 5, 6, 8]) {
      const rng = mulberry32(100 + seats);
      const done = runDraft(createDraft(seats, { mulligans: 1 }), makePool(120), rng, (st, seat) =>
        applyAction(st, seat, { type: "pick", card: legalPicksOf(st)[0] }),
      );
      expectValidBoards(done);
      // spread size matches the table size throughout
      expect(done.packSeq).toBe(done.roundSeq * packsPerSpread(seats));
    }
  });

  it("fuzz: random legal actions always terminate with legal boards (2-8 seats)", () => {
    for (let iter = 0; iter < 120; iter++) {
      const rng = mulberry32(iter * 7 + 1);
      const seats = 2 + (iter % 7);
      const done = runDraft(createDraft(seats, { mulligans: 2 }), makePool(160), rng, (st, seat) => {
        const legal = legalActions(st, seat);
        const options: (() => ReturnType<typeof applyAction>)[] = [];
        for (const pick of legal.picks) {
          options.push(() => applyAction(st, seat, { type: "pick", card: pick }));
        }
        if (legal.canDeny && st.currentPacks.length) {
          const cards = st.currentPacks.flatMap((p) => [
            ...p.players.map((x) => ({ kind: "player" as const, steamId: x.steamId })),
            ...p.heroes.map((h) => ({ kind: "hero" as const, heroId: h })),
          ]);
          if (cards.length) {
            options.push(() =>
              applyAction(st, seat, {
                type: "deny",
                card: cards[Math.floor(rng() * cards.length)],
              }),
            );
          }
        }
        if (legal.canPass) options.push(() => applyAction(st, seat, { type: "pass" }));
        if (legal.canMulligan) options.push(() => applyAction(st, seat, { type: "mulligan" }));
        return options[Math.floor(rng() * options.length)]();
      });
      expectValidBoards(done);
    }
  });

  it("autopick is deterministic and can finish a whole draft by itself", () => {
    const phs = {};
    const rng = mulberry32(31337);
    const done = runDraft(createDraft(6, { mulligans: 1 }), makePool(120), rng, (st, seat) => {
      const a1 = autopick(st, seat, phs);
      const a2 = autopick(st, seat, phs);
      expect(a1).toEqual(a2);
      return applyAction(st, seat, a1);
    });
    expectValidBoards(done);
  });
});

// ---------------------------------------------------------------------------
// Turbo — the booster chain
// ---------------------------------------------------------------------------

function turboDraft(seats: number, mulligans = 0): EngineState {
  return createDraft(seats, { mulligans, mode: "turbo" });
}

/** Seats currently holding a pack they must act on. */
function readySeats(s: EngineState): number[] {
  return Array.from({ length: s.numSeats }, (_, i) => i).filter(
    (seat) => activePackIndex(s, seat) >= 0,
  );
}

/** Play a full turbo draft: whenever any seat holds a pack, the strategy acts. */
function runTurboDraft(
  s: EngineState,
  pool: Pack[],
  rng: Rng,
  act: (s: EngineState, seat: number) => ReturnType<typeof applyAction>,
): EngineState {
  let guard = 0;
  while (!s.done) {
    if (++guard > 8000) throw new Error("draft did not terminate");
    if (s.owedPacks.length || !s.currentPacks.length) {
      s = dealTurbo(s, pool, rng);
      continue;
    }
    const ready = readySeats(s);
    if (!ready.length) throw new Error("chain stalled with packs in flight");
    const seat = ready[Math.floor(rng() * ready.length)];
    const r = act(s, seat);
    if (r.error) throw new Error(`action failed: ${r.error}`);
    s = r.state;
  }
  return s;
}

describe("turbo waves", () => {
  it("deals one pack to every seat: everyone has a turn at once", () => {
    const s = dealTurbo(turboDraft(4), makePool(), mulberry32(1));
    expect(s.currentPacks).toHaveLength(4);
    expect(s.packDealtTo).toEqual([0, 1, 2, 3]);
    expect(s.packPassCount).toEqual([0, 0, 0, 0]);
    expect(s.roundSeq).toBe(1);
    expect(s.packSeq).toBe(4);
    expect(s.turnSeat).toBeNull();
    expect(readySeats(s)).toEqual([0, 1, 2, 3]);
    // in-flight packs never share a player
    const ids = s.currentPacks.flatMap((p) => p.players.map((x) => x.steamId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("seats act on the same state without waiting on each other", () => {
    let s = dealTurbo(turboDraft(3), makePool(), mulberry32(2));
    s = applyAction(s, 2, { type: "pick", card: legalActions(s, 2).picks[0] }).state;
    expect(applyAction(s, 0, { type: "pick", card: legalActions(s, 0).picks[0] }).error)
      .toBeUndefined();
  });

  it("acting passes the leftovers down the chain; arrivals queue behind the pack in hand", () => {
    let s = dealTurbo(turboDraft(3), makePool(), mulberry32(3));
    const passed = s.currentPacks[0].id;
    const own = s.currentPacks[1].id;
    s = applyAction(s, 0, { type: "pick", card: legalActions(s, 0).picks[0] }).state;
    // seat 0's leftovers are now in seat 1's hands…
    expect(s.currentPacks[0].id).toBe(passed);
    expect(packHolder(s, 0)).toBe(1);
    // …queued behind the pack seat 1 was dealt, which arrived first
    expect(s.currentPacks[activePackIndex(s, 1)].id).toBe(own);
    // seat 0 holds nothing until the chain comes around
    expect(activePackIndex(s, 0)).toBe(-1);
    expect(legalActions(s, 0).picks).toHaveLength(0);
  });

  it("a pack every seat has acted on is discarded; an empty table starts a new wave", () => {
    let s = dealTurbo(turboDraft(2), makePool(), mulberry32(4));
    for (let k = 0; k < 4; k++) {
      const seat = readySeats(s)[0];
      s = applyAction(s, seat, { type: "pick", card: legalActions(s, seat).picks[0] }).state;
    }
    expect(s.currentPacks).toHaveLength(0);
    s = dealTurbo(s, makePool(), mulberry32(5));
    expect(s.roundSeq).toBe(2);
    expect(s.currentPacks).toHaveLength(2);
  });

  it("there is no manual pass in turbo", () => {
    const s = dealTurbo(turboDraft(2), makePool(), mulberry32(6));
    expect(legalActions(s, 0).canPass).toBe(false);
    expect(applyAction(s, 0, { type: "pass" }).error).toBe("cannot-pass");
  });
});

describe("turbo skip rule", () => {
  /** Seat 1 with every role the pack offers filled and all five heroes drafted. */
  function skipState(): EngineState {
    const pack = makePack(1, ["safelane", "safelane", "safelane", "safelane", "safelane"], 10);
    const s = turboDraft(3);
    s.boards[1] = board(
      {
        safelane: makePlayer(9001, "safelane"),
        offlane: makePlayer(9002, "offlane"),
        support1: makePlayer(9003, "support"),
        support2: makePlayer(9004, "support"),
      },
      [11, 12, 13, 14, 15], // heroes complete — exactly the pack's signature five
    );
    s.takenSteamIds = [9001, 9002, 9003, 9004];
    s.currentPacks = [materialize(pack, mulberry32(7))];
    s.packDealtTo = [0];
    s.packPassCount = [0];
    s.usedPackIds = [pack.id];
    return s;
  }

  it("a pack with nothing for an arriving seat passes through by itself", () => {
    let s = skipState();
    const pick = legalActions(s, 0).picks.find((c) => c.kind === "player")!;
    s = applyAction(s, 0, { type: "pick", card: pick }).state;
    // seat 1 was skipped without acting: the pack sits with seat 2
    expect(s.packPassCount[0]).toBe(2);
    expect(packHolder(s, 0)).toBe(2);
    expect(activePackIndex(s, 1)).toBe(-1);
    expect(legalActions(s, 1).picks).toHaveLength(0);
  });

  it("…and is discarded once every seat has acted or been skipped", () => {
    let s = skipState();
    s = applyAction(s, 0, { type: "pick", card: legalActions(s, 0).picks[0] }).state;
    s = applyAction(s, 2, { type: "pick", card: legalActions(s, 2).picks[0] }).state;
    expect(s.currentPacks).toHaveLength(0);
  });
});

describe("turbo deny and mulligan", () => {
  it("deny burns your pick on the pack in your hands and sends the leftovers on", () => {
    let s = dealTurbo(turboDraft(2), makePool(), mulberry32(8));
    const victim = s.currentPacks[activePackIndex(s, 0)].players[0];
    s = applyAction(s, 0, { type: "deny", card: { kind: "player", steamId: victim.steamId } }).state;
    expect(s.deniesLeft[0]).toBe(0);
    expect(s.takenSteamIds).toContain(victim.steamId);
    expect(s.deniedShelf[0].bySeat).toBe(0);
    // the deny consumed seat 0's act on that pack — it moved to seat 1
    expect(packHolder(s, 0)).toBe(1);
    expect(applyAction(s, 0, { type: "deny", card: { kind: "hero", heroId: 1 } }).error).toBe(
      "no-pack",
    );
  });

  it("mulligan burns only a freshly dealt pack; the replacement comes back to that seat", () => {
    let s = dealTurbo(createDraft(2, { mulligans: 1, mode: "turbo" }), makePool(), mulberry32(9));
    const burned = s.currentPacks[activePackIndex(s, 0)].id;
    expect(legalActions(s, 0).canMulligan).toBe(true);
    s = applyAction(s, 0, { type: "mulligan" }).state;
    expect(s.mulligansLeft[0]).toBe(0);
    expect(s.owedPacks).toEqual([0]);
    expect(s.currentPacks.some((p) => p.id === burned)).toBe(false);
    s = dealTurbo(s, makePool(), mulberry32(10));
    expect(s.owedPacks).toEqual([]);
    const replacement = activePackIndex(s, 0);
    expect(replacement).toBeGreaterThanOrEqual(0);
    expect(s.currentPacks[replacement].id).not.toBe(burned);
    expect(s.packPassCount[replacement]).toBe(0);
    expect(s.usedPackIds).toContain(burned);
  });

  it("a pack someone already acted on cannot be mulliganed", () => {
    let s = dealTurbo(createDraft(2, { mulligans: 2, mode: "turbo" }), makePool(), mulberry32(11));
    s = applyAction(s, 0, { type: "pick", card: legalActions(s, 0).picks[0] }).state;
    s = applyAction(s, 1, { type: "pick", card: legalActions(s, 1).picks[0] }).state;
    // seat 1's hand is now seat 0's leftovers — passed once already
    expect(s.packPassCount[activePackIndex(s, 1)]).toBe(1);
    expect(legalActions(s, 1).canMulligan).toBe(false);
    expect(applyAction(s, 1, { type: "mulligan" }).error).toBe("illegal-mulligan");
  });
});

describe("turbo full drafts", () => {
  it("greedy chains complete with legal boards at every table size", () => {
    for (const seats of [2, 3, 4, 5, 6, 8]) {
      const rng = mulberry32(200 + seats);
      const done = runTurboDraft(turboDraft(seats), makePool(160), rng, (st, seat) =>
        applyAction(st, seat, { type: "pick", card: legalActions(st, seat).picks[0] }),
      );
      expectValidBoards(done);
    }
  });

  it("fuzz: random turbo actions always terminate with legal boards (2-8 seats)", () => {
    for (let iter = 0; iter < 60; iter++) {
      const rng = mulberry32(iter * 13 + 3);
      const seats = 2 + (iter % 7);
      const done = runTurboDraft(
        createDraft(seats, { mulligans: 2, mode: "turbo" }),
        makePool(200),
        rng,
        (st, seat) => {
          const legal = legalActions(st, seat);
          const options: (() => ReturnType<typeof applyAction>)[] = [];
          for (const pick of legal.picks) {
            options.push(() => applyAction(st, seat, { type: "pick", card: pick }));
          }
          if (legal.canDeny) {
            const pack = st.currentPacks[activePackIndex(st, seat)];
            const cards: CardRef[] = [
              ...pack.players.map((x) => ({ kind: "player" as const, steamId: x.steamId })),
              ...pack.heroes.map((h) => ({ kind: "hero" as const, heroId: h })),
            ];
            options.push(() =>
              applyAction(st, seat, { type: "deny", card: cards[Math.floor(rng() * cards.length)] }),
            );
          }
          if (legal.canMulligan) options.push(() => applyAction(st, seat, { type: "mulligan" }));
          return options[Math.floor(rng() * options.length)]();
        },
      );
      expectValidBoards(done);
    }
  });

  it("autopick can finish a whole turbo draft by itself", () => {
    const rng = mulberry32(777);
    const done = runTurboDraft(turboDraft(6), makePool(160), rng, (st, seat) =>
      applyAction(st, seat, autopick(st, seat, {})),
    );
    expectValidBoards(done);
  });
});

describe("real card pool", () => {
  it("random drafts over the real pool terminate with legal boards (incl. 8 seats)", async () => {
    const load = async (name: string) =>
      JSON.parse(await readFile(path.join(process.cwd(), "public/data", name), "utf8"));
    const bundle: DataBundle = {
      events: await load("events.json"),
      packs: await load("packs.json"),
      heroes: await load("heroes.json"),
      playerHeroStats: await load("playerHeroStats.json"),
      squadSynergy: await load("squadSynergy.json"),
    };
    const runs: { mode: "career" | "peak" | "event"; seats: number; seed: number }[] = [
      { mode: "career", seats: 8, seed: 1 },
      { mode: "peak", seats: 6, seed: 2 },
      { mode: "event", seats: 4, seed: 3 },
    ];
    for (const { mode, seats, seed } of runs) {
      const pool = buildCardPool(bundle, "valve_legacy", mode).packs;
      const rng = mulberry32(seed);
      const done = runDraft(createDraft(seats, { mulligans: 1 }), pool, rng, (st, seat) => {
        const legal = legalActions(st, seat);
        const pick = legal.picks[Math.floor(rng() * legal.picks.length)];
        return pick
          ? applyAction(st, seat, { type: "pick", card: pick })
          : applyAction(st, seat, { type: "pass" });
      });
      expect(done.done).toBe(true);
      for (const b of done.boards) expect(isComplete(b.slots, b.heroes)).toBe(true);
    }
  });

  it("random turbo drafts over the real pool terminate with legal boards", async () => {
    const load = async (name: string) =>
      JSON.parse(await readFile(path.join(process.cwd(), "public/data", name), "utf8"));
    const bundle: DataBundle = {
      events: await load("events.json"),
      packs: await load("packs.json"),
      heroes: await load("heroes.json"),
      playerHeroStats: await load("playerHeroStats.json"),
      squadSynergy: await load("squadSynergy.json"),
    };
    for (const { seats, seed } of [
      { seats: 8, seed: 4 },
      { seats: 3, seed: 5 },
    ]) {
      const pool = buildCardPool(bundle, "valve_legacy", "career").packs;
      const rng = mulberry32(seed);
      const done = runTurboDraft(
        createDraft(seats, { mulligans: 1, mode: "turbo" }),
        pool,
        rng,
        (st, seat) => {
          const picks = legalActions(st, seat).picks;
          return applyAction(st, seat, {
            type: "pick",
            card: picks[Math.floor(rng() * picks.length)],
          });
        },
      );
      expect(done.done).toBe(true);
      for (const b of done.boards) expect(isComplete(b.slots, b.heroes)).toBe(true);
    }
  });
});
