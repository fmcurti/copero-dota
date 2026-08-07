import { shuffle, type Rng } from "./rng";
import type { Pack, PackPlayer, Role, RosterPlayer, SlotId } from "./types";

// ---------------------------------------------------------------------------
// Draft rules (faithful to the original):
//  - A drawn "pack" is a team at an event: its 5 players + 5 of its signature
//    heroes. You pick exactly ONE card from it (a player or a hero), then a
//    new pack is drawn.
//  - Roster slots: safelane / mid / offlane / support1 / support2.
//  - A player already picked (by steamId) can never be offered again.
//  - The run is complete at 5 players + 5 heroes.
// ---------------------------------------------------------------------------

export const SLOT_IDS: SlotId[] = ["safelane", "mid", "offlane", "support1", "support2"];
export const HERO_COUNT = 5;

export type Slots = Record<SlotId, RosterPlayer | null>;

export function emptySlots(): Slots {
  return { safelane: null, mid: null, offlane: null, support1: null, support2: null };
}

/** The slot a player of this role would fill, or null if occupied. */
export function slotForRole(role: Role, slots: Slots): SlotId | null {
  if (role === "support") {
    if (!slots.support1) return "support1";
    if (!slots.support2) return "support2";
    return null;
  }
  return slots[role] ? null : role;
}

export function pickedIds(slots: Slots): Set<number> {
  return new Set(
    SLOT_IDS.map((s) => slots[s])
      .filter((p): p is RosterPlayer => Boolean(p))
      .map((p) => p.steamId),
  );
}

export function canPickPlayer(p: PackPlayer, slots: Slots, picked: Set<number>): boolean {
  return !picked.has(p.steamId) && slotForRole(p.role, slots) !== null;
}

export function canPickHero(heroId: number, heroes: number[]): boolean {
  return heroes.length < HERO_COUNT && !heroes.includes(heroId);
}

export function isComplete(slots: Slots, heroes: number[]): boolean {
  return SLOT_IDS.every((s) => slots[s]) && heroes.length >= HERO_COUNT;
}

/** A drawn pack as shown to the drafter. */
export interface DrawnPack {
  id: string;
  teamName: string;
  eventId: string;
  placement: number | null;
  players: RosterPlayer[];
  heroes: number[]; // 5 of the team's signature heroes
}

export function materialize(pack: Pack, rng: Rng): DrawnPack {
  return {
    id: pack.id,
    teamName: pack.teamName,
    eventId: pack.eventId,
    placement: pack.placement,
    players: pack.players.map((p) => ({ ...p, team: pack.teamName, eventId: pack.eventId })),
    heroes: shuffle(rng, pack.signatureHeroes).slice(0, HERO_COUNT),
  };
}

function packHasPick(drawn: DrawnPack, slots: Slots, heroes: number[], picked: Set<number>): boolean {
  return (
    drawn.players.some((p) => canPickPlayer(p, slots, picked)) ||
    drawn.heroes.some((h) => canPickHero(h, heroes))
  );
}

/** Whether a pack could offer at least one pickable card (before choosing which 5 heroes to show). */
export function packPickable(pack: Pack, slots: Slots, heroes: number[], picked: Set<number>): boolean {
  return (
    pack.players.some((p) => canPickPlayer(p, slots, picked)) ||
    (heroes.length < HERO_COUNT && pack.signatureHeroes.some((h) => !heroes.includes(h)))
  );
}

/**
 * Draw a random pack that is guaranteed to contain at least one pickable card.
 * (The original samples 80 times and can give up, which soft-locks the draft
 * in rare endgame spots — e.g. only the mid slot left, heroes full, and the
 * shown pack has no mid. We filter the pool instead, so a legal pick always
 * exists; a stuck state is impossible unless the whole pool is exhausted.)
 */
export function drawPack(pool: Pack[], slots: Slots, heroes: number[], rng: Rng): DrawnPack | null {
  if (!pool.length) return null;
  const picked = pickedIds(slots);
  const eligible = pool.filter((p) => packPickable(p, slots, heroes, picked));
  const source = eligible.length ? eligible : pool;
  let drawn = materialize(source[Math.floor(rng() * source.length)], rng);
  if (!packHasPick(drawn, slots, heroes, picked)) {
    // The pack qualified via its heroes, but the 5-of-N shuffle happened to
    // show only already-drafted ones — swap a pickable hero into the display.
    const pack = source.find((p) => p.id === drawn.id)!;
    const pickableHero = pack.signatureHeroes.find((h) => canPickHero(h, heroes));
    if (pickableHero != null) {
      drawn = { ...drawn, heroes: [...drawn.heroes.slice(0, HERO_COUNT - 1), pickableHero] };
    }
  }
  return drawn;
}
