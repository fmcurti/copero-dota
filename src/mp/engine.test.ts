import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCardPool } from "../game/cards";
import { emptySlots, isComplete, SLOT_IDS } from "../game/draft";
import { mulberry32 } from "../game/rng";
import { autopick } from "./autopick";
import {
  applyAction,
  boardComplete,
  createDraft,
  legalActions,
  openPack,
  type EngineState,
} from "./engine";
import type { Board } from "./protocol";
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

/** Play a full draft: every turn takes the given strategy's action. */
function runDraft(
  s: EngineState,
  pool: Pack[],
  rng: () => number,
  act: (s: EngineState, seat: number) => ReturnType<typeof applyAction>,
): EngineState {
  let guard = 0;
  while (!s.done) {
    if (++guard > 3000) throw new Error("draft did not terminate");
    if (!s.currentPack) {
      s = openPack(s, pool, rng);
      continue;
    }
    const seat = s.turnSeat;
    if (seat == null) throw new Error("open pack but no turn");
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
  it("opens a pack and gives the opener the first turn", () => {
    const s = openPack(createDraft(3, { mulligans: 1 }), makePool(), mulberry32(1));
    expect(s.currentPack).not.toBeNull();
    expect(s.packSeq).toBe(1);
    expect(s.turnSeat).toBe(0);
    expect(s.usedPackIds).toHaveLength(1);
  });

  it("rotates the turn around the table, then discards the pack and rotates the opener", () => {
    let s = openPack(createDraft(3, { mulligans: 1 }), makePool(), mulberry32(2));
    for (const expected of [0, 1, 2]) {
      expect(s.turnSeat).toBe(expected);
      const pick = legalActions(s, expected).picks[0];
      s = applyAction(s, expected, { type: "pick", card: pick }).state;
    }
    expect(s.currentPack).toBeNull();
    expect(s.turnSeat).toBeNull();
    expect(s.openerSeat).toBe(1);
  });

  it("rejects out-of-turn actions and illegal picks", () => {
    const pool = makePool();
    const s = openPack(createDraft(2, { mulligans: 1 }), pool, mulberry32(3));
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
    // fix roles: replace the mid of pack 2 with the same shared player
    const p2 = makePack(2, FULL_ROLES, 20);
    const pB: Pack = { ...p2, players: p2.players.map((p) => (p.role === "mid" ? shared : p)) };
    expect(pA.players.some((p) => p.steamId === 7777)).toBe(true);

    let s = createDraft(2, { mulligans: 0 });
    s = openPack(s, [pA], mulberry32(4));
    // seat 0 takes the shared player
    s = applyAction(s, 0, { type: "pick", card: { kind: "player", steamId: 7777 } }).state;
    // seat 1 acts on something else; pack ends
    s = applyAction(s, 1, { type: "pick", card: legalActions(s, 1).picks[0] }).state;
    s = openPack(s, [pB], mulberry32(5));
    const picks = legalActions(s, s.turnSeat!).picks;
    expect(picks.some((c) => c.kind === "player" && c.steamId === 7777)).toBe(false);
  });
});

describe("deny", () => {
  it("denied player is destroyed globally, consumes the action and a deny", () => {
    const pool = makePool();
    let s = openPack(createDraft(2, { mulligans: 0 }), pool, mulberry32(6));
    const victim = s.currentPack!.players[0];
    s = applyAction(s, 0, { type: "deny", card: { kind: "player", steamId: victim.steamId } }).state;
    expect(s.deniesLeft[0]).toBe(0);
    expect(s.takenSteamIds).toContain(victim.steamId);
    expect(s.deniedShelf).toHaveLength(1);
    expect(s.deniedShelf[0].bySeat).toBe(0);
    expect(s.currentPack!.players.some((p) => p.steamId === victim.steamId)).toBe(false);
    expect(s.turnSeat).toBe(1); // action consumed, turn moved on
  });

  it("denied hero only leaves this pack — it can be drafted from a later pack", () => {
    // Both packs share hero 42.
    const pA = { ...makePack(1, FULL_ROLES, 0), signatureHeroes: [42, 43, 44, 45, 46] };
    const pB = { ...makePack(2, FULL_ROLES, 0), signatureHeroes: [42, 53, 54, 55, 56] };
    let s = createDraft(2, { mulligans: 0 });
    s = openPack(s, [pA], mulberry32(7));
    s = applyAction(s, 0, { type: "deny", card: { kind: "hero", heroId: 42 } }).state;
    expect(s.currentPack!.heroes).not.toContain(42);
    s = applyAction(s, 1, { type: "pick", card: legalActions(s, 1).picks[0] }).state;
    s = openPack(s, [pB], mulberry32(8));
    const picks = legalPicksOf(s);
    expect(picks.some((c) => c.kind === "hero" && c.heroId === 42)).toBe(true);
  });

  it("cannot deny with no denies left", () => {
    const pool = makePool();
    let s = openPack(createDraft(2, { mulligans: 0 }), pool, mulberry32(9));
    s.deniesLeft = [0, 0];
    const card = { kind: "player" as const, steamId: s.currentPack!.players[0].steamId };
    expect(applyAction(s, 0, { type: "deny", card }).error).toBe("cannot-deny");
  });
});

function legalPicksOf(s: EngineState) {
  return legalActions(s, s.turnSeat!).picks;
}

describe("mulligan", () => {
  it("opener may mulligan before acting: replacement pack, same opener, one mulligan spent", () => {
    const pool = makePool();
    let s = openPack(createDraft(3, { mulligans: 1 }), pool, mulberry32(10));
    const burned = s.currentPack!.id;
    expect(legalActions(s, 0).canMulligan).toBe(true);
    s = applyAction(s, 0, { type: "mulligan" }).state;
    expect(s.mulligansLeft[0]).toBe(0);
    expect(s.currentPack).toBeNull();
    s = openPack(s, pool, mulberry32(11));
    expect(s.openerSeat).toBe(0); // same opener re-opens
    expect(s.currentPack!.id).not.toBe(burned); // burned pack is used up
    expect(s.usedPackIds).toContain(burned);
  });

  it("non-openers cannot mulligan; opener cannot after acting", () => {
    const pool = makePool();
    let s = openPack(createDraft(2, { mulligans: 2 }), pool, mulberry32(12));
    expect(legalActions(s, 1).canMulligan).toBe(false);
    expect(applyAction(s, 1, { type: "mulligan" }).error).toBe("illegal-mulligan");
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s) [0] }).state;
    expect(legalActions(s, 0).canMulligan).toBe(false);
  });
});

describe("skips and passes", () => {
  it("a seat with no legal pick and no deny left is auto-passed", () => {
    // Seat 1: heroes full, only mid open — pack has no mid and no pickable hero for them.
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
    s = openPack(s, [pack], mulberry32(13));
    expect(s.turnSeat).toBe(0);
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s)[0] }).state;
    // seat 1 was auto-passed: pack over, no error state
    expect(s.currentPack).toBeNull();
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
    s = openPack(s, [pack], mulberry32(14));
    s = applyAction(s, 0, { type: "pick", card: legalPicksOf(s)[0] }).state;
    expect(s.turnSeat).toBe(1);
    const legal = legalActions(s, 1);
    expect(legal.picks).toHaveLength(0);
    expect(legal.canDeny).toBe(true);
    expect(legal.canPass).toBe(true);
    s = applyAction(s, 1, { type: "pass" }).state;
    expect(s.currentPack).toBeNull();
  });

  it("completed boards are skipped entirely and the draft finishes", () => {
    let s = createDraft(2, { mulligans: 0 });
    // Seat 1 is already complete.
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
  it("greedy 2/3/4-seat drafts complete with legal boards", () => {
    for (const seats of [2, 3, 4]) {
      const rng = mulberry32(100 + seats);
      const done = runDraft(createDraft(seats, { mulligans: 1 }), makePool(60), rng, (st, seat) =>
        applyAction(st, seat, { type: "pick", card: legalPicksOf(st)[0] }),
      );
      expectValidBoards(done);
    }
  });

  it("fuzz: random legal actions always terminate with legal boards", () => {
    for (let iter = 0; iter < 120; iter++) {
      const rng = mulberry32(iter * 7 + 1);
      const seats = 2 + (iter % 3);
      const done = runDraft(createDraft(seats, { mulligans: 2 }), makePool(80), rng, (st, seat) => {
        const legal = legalActions(st, seat);
        const options: (() => ReturnType<typeof applyAction>)[] = [];
        for (const pick of legal.picks) {
          options.push(() => applyAction(st, seat, { type: "pick", card: pick }));
        }
        if (legal.canDeny && st.currentPack) {
          const cards = [
            ...st.currentPack.players.map((p) => ({ kind: "player" as const, steamId: p.steamId })),
            ...st.currentPack.heroes.map((h) => ({ kind: "hero" as const, heroId: h })),
          ];
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
    const phs = {}; // no hero stats → pure OVR/first-hero ordering, still deterministic
    const rng = mulberry32(31337);
    const done = runDraft(createDraft(3, { mulligans: 1 }), makePool(60), rng, (st, seat) => {
      const a1 = autopick(st, seat, phs);
      const a2 = autopick(st, seat, phs);
      expect(a1).toEqual(a2);
      return applyAction(st, seat, a1);
    });
    expectValidBoards(done);
  });
});

describe("real card pool", () => {
  it("4-seat random draft over the real career-mode pool terminates with legal boards", async () => {
    const load = async (name: string) =>
      JSON.parse(await readFile(path.join(process.cwd(), "public/data", name), "utf8"));
    const bundle: DataBundle = {
      events: await load("events.json"),
      packs: await load("packs.json"),
      heroes: await load("heroes.json"),
      playerHeroStats: await load("playerHeroStats.json"),
      squadSynergy: await load("squadSynergy.json"),
    };
    for (const mode of ["career", "peak", "event"] as const) {
      const pool = buildCardPool(bundle, "valve_legacy", mode).packs;
      const rng = mulberry32(mode === "career" ? 1 : mode === "peak" ? 2 : 3);
      const done = runDraft(createDraft(4, { mulligans: 1 }), pool, rng, (st, seat) => {
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
});
