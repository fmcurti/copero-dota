import { MAX_SEATS, type Phase, type RoomVisibility } from "./protocol";

// ---------------------------------------------------------------------------
// The room directory, minus all the plumbing. Durable Objects can't be listed,
// so rooms announce themselves into one global directory DO and the home page
// reads it back. This module is the part both ends share: what an entry looks
// like, which list it belongs on, and when it has gone stale.
//
// Visibility *policy* is not here — the room decides whether it has a listing
// at all (see listingFor() in worker/index.ts). An entry that reaches this
// module is already safe to show to anyone.
// ---------------------------------------------------------------------------

export interface RoomListing {
  /** The room code, verbatim — it is also the Durable Object name, so casing matters. */
  code: string;
  visibility: Exclude<RoomVisibility, "private">;
  phase: Phase;
  /** Drafters seated, and the cap they are filling. */
  seats: number;
  maxSeats: number;
  host: string;
  /** Seat names in seat order — the flavour that makes a row worth reading. */
  teams: string[];
  /** Connected but unseated. */
  watchers: number;
  /** Room-side stamp. Publishes are fire-and-forget, so this orders them. */
  rev: number;
  /** Directory-side stamp of the last time this entry was confirmed alive. */
  updatedAt: number;
}

/** An entry as the room sends it — the directory stamps `updatedAt` itself. */
export type DirectoryEntry = Omit<RoomListing, "updatedAt">;

/** Past this without confirmation, an entry is never shown and gets swept. */
export const LISTING_TTL_MS = 20 * 60_000;
/** Older than this and the directory wakes the room to ask if anyone is left. */
export const PROBE_AFTER_MS = 6 * 60_000;
export const DIRECTORY_TICK_MS = 2 * 60_000;
/** A room re-publishes an unchanged entry at most this often, to stay fresh. */
export const TOUCH_MS = 5 * 60_000;
export const MAX_LISTINGS = 200;
export const MAX_PROBES_PER_TICK = 20;

/** Lower sorts first: games in progress above lobbies, finished last. */
const PHASE_RANK: Record<Phase, number> = {
  drafting: 0,
  assembled: 1,
  broadcasting: 2,
  lobby: 3,
  done: 4,
};

export const isFresh = (l: RoomListing, now: number): boolean =>
  now - l.updatedAt < LISTING_TTL_MS;

/** Home page: a public lobby with room to spare, which anyone may walk into. */
export const isJoinable = (l: RoomListing): boolean =>
  l.visibility === "public" && l.phase === "lobby" && l.seats < l.maxSeats;

/** Watch page: a game already under way. Lobbies and finished rooms never qualify. */
export const isWatchable = (l: RoomListing): boolean =>
  l.phase === "drafting" || l.phase === "assembled" || l.phase === "broadcasting";

export function openLobbies(all: RoomListing[], now: number): RoomListing[] {
  return all
    .filter((l) => isFresh(l, now) && isJoinable(l))
    .sort((a, b) => b.seats - a.seats || b.rev - a.rev || a.code.localeCompare(b.code));
}

export function liveGames(all: RoomListing[], now: number): RoomListing[] {
  return all
    .filter((l) => isFresh(l, now) && isWatchable(l))
    .sort(
      (a, b) =>
        PHASE_RANK[a.phase] - PHASE_RANK[b.phase] ||
        b.watchers - a.watchers ||
        b.seats - a.seats ||
        a.code.localeCompare(b.code),
    );
}

/** Rotted past the TTL — delete outright. */
export const staleCodes = (all: RoomListing[], now: number): string[] =>
  all.filter((l) => !isFresh(l, now)).map((l) => l.code);

/** Quiet for a while but not yet rotted: wake and re-confirm, oldest first. */
export const probeCodes = (all: RoomListing[], now: number): string[] =>
  all
    .filter((l) => isFresh(l, now) && now - l.updatedAt >= PROBE_AFTER_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, MAX_PROBES_PER_TICK)
    .map((l) => l.code);

/** Over cap: evict the least recently confirmed. */
export const overflowCodes = (all: RoomListing[]): string[] =>
  all.length <= MAX_LISTINGS
    ? []
    : [...all]
        .sort((a, b) => a.updatedAt - b.updatedAt)
        .slice(0, all.length - MAX_LISTINGS)
        .map((l) => l.code);

/**
 * Dedupe key: everything a viewer can see, and nothing else — the clocks are
 * left out on purpose. A room compares this against its last publish, so a
 * 40-pick draft, which changes nothing on a list row, costs zero writes.
 */
export const listingKey = (l: DirectoryEntry | null): string =>
  l === null
    ? "none"
    : JSON.stringify([
        l.code,
        l.visibility,
        l.phase,
        l.seats,
        l.maxSeats,
        l.watchers,
        l.host,
        l.teams,
      ]);

export { MAX_SEATS };
