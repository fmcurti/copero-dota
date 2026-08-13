import { MAX_SEATS, type Phase, type RoomVisibility, type Seat } from "./protocol";

// ---------------------------------------------------------------------------
// The Directory policy module. Rooms, the Directory Durable Object, and the
// browser all use the same two operations:
//
// - roomDirectory decides whether a Room is safe to publish and whether its
//   current listing needs announcing.
// - directoryView derives everything consumers may do with stored listings:
//   show them, bucket them, probe them, or evict them.
//
// Durable Object RPC, storage, probes, and browser fetch stay in adapters.
// ---------------------------------------------------------------------------

export interface RoomListing {
  /** The Room code, verbatim — it is also the Durable Object name. */
  code: string;
  /** Which room class this is: watch links and liveness probes differ. */
  kind: "casual" | "ranked";
  visibility: Exclude<RoomVisibility, "private">;
  phase: Phase;
  seats: number;
  maxSeats: number;
  host: string;
  teams: string[];
  /** Connected but unseated visitors. */
  watchers: number;
  /** Room-side stamp. Fire-and-forget publishes use this for ordering. */
  rev: number;
  /** Directory-side stamp of the last liveness confirmation. */
  updatedAt: number;
}

export type DirectoryEntry = Omit<RoomListing, "updatedAt">;

export interface DirectoryPublicationState {
  key: string;
  publishedAt: number;
}

export interface RoomDirectoryFacts {
  code: string;
  kind: "casual" | "ranked";
  visibility: RoomVisibility;
  phase: Phase;
  seats: Seat[];
  /** playerIds with at least one open connection. Duplicates are harmless. */
  connectedPlayerIds: Iterable<string>;
  now: number;
}

export interface RoomDirectoryResult {
  /** The listing currently safe to expose, or null when the Room is hidden. */
  entry: DirectoryEntry | null;
  /** undefined means the cached publication is still fresh and unchanged. */
  publication: DirectoryEntry | null | undefined;
  state: DirectoryPublicationState;
}

export interface DirectoryView {
  /** Fresh listings safe to return from /api/rooms. */
  rooms: RoomListing[];
  openLobbies: RoomListing[];
  liveGames: RoomListing[];
  staleCodes: string[];
  probeCodes: string[];
  overflowCodes: string[];
  /** Next Directory alarm, or null when no listing remains. */
  nextTickAt: number | null;
}

const LISTING_TTL_MS = 20 * 60_000;
const PROBE_AFTER_MS = 6 * 60_000;
const DIRECTORY_TICK_MS = 2 * 60_000;
const TOUCH_MS = 5 * 60_000;
const MAX_LISTINGS = 200;
const MAX_PROBES_PER_TICK = 20;

const PHASE_RANK: Record<Phase, number> = {
  drafting: 0,
  assembled: 1,
  broadcasting: 2,
  lobby: 3,
  done: 4,
};

const listingKey = (entry: DirectoryEntry | null): string =>
  entry === null
    ? "none"
    : JSON.stringify([
        entry.code,
        entry.kind,
        entry.visibility,
        entry.phase,
        entry.seats,
        entry.maxSeats,
        entry.watchers,
        entry.host,
        entry.teams,
      ]);

function listingOf(facts: RoomDirectoryFacts): DirectoryEntry | null {
  const { visibility, phase, seats, now } = facts;
  if (visibility === "private" || phase === "done") return null;
  if (visibility === "spectatable" && phase === "lobby") return null;

  const connected = new Set(facts.connectedPlayerIds);
  if (connected.size === 0) return null;

  const seated = new Set(seats.map((seat) => seat.playerId));
  let watchers = 0;
  for (const playerId of connected) if (!seated.has(playerId)) watchers++;

  return {
    code: facts.code,
    kind: facts.kind,
    visibility,
    phase,
    seats: seats.length,
    maxSeats: MAX_SEATS,
    host: seats.find((seat) => seat.isHost)?.name ?? "",
    teams: seats.map((seat) => seat.name),
    watchers,
    rev: now,
  };
}

/**
 * Derive the Room's safe listing and its next publication. Unchanged visible
 * listings get a periodic touch; repeated retractions cost nothing.
 */
export function roomDirectory(
  facts: RoomDirectoryFacts,
  previous: DirectoryPublicationState | null,
): RoomDirectoryResult {
  const entry = listingOf(facts);
  const key = listingKey(entry);
  const shouldPublish =
    previous === null ||
    previous.key !== key ||
    (entry !== null && facts.now - previous.publishedAt >= TOUCH_MS);
  const state = shouldPublish
    ? { key, publishedAt: facts.now }
    : (previous as DirectoryPublicationState);
  return { entry, publication: shouldPublish ? entry : undefined, state };
}

/** Derive every public and maintenance view of the stored Directory. */
export function directoryView(all: RoomListing[], now: number): DirectoryView {
  const fresh = (listing: RoomListing) => now - listing.updatedAt < LISTING_TTL_MS;
  const rooms = all.filter(fresh);
  const openLobbies = rooms
    .filter(
      (listing) =>
        listing.visibility === "public" &&
        listing.phase === "lobby" &&
        listing.seats < listing.maxSeats,
    )
    .sort(
      (a, b) => b.seats - a.seats || b.rev - a.rev || a.code.localeCompare(b.code),
    );
  const liveGames = rooms
    .filter(
      (listing) =>
        listing.phase === "drafting" ||
        listing.phase === "assembled" ||
        listing.phase === "broadcasting",
    )
    .sort(
      (a, b) =>
        PHASE_RANK[a.phase] - PHASE_RANK[b.phase] ||
        b.watchers - a.watchers ||
        b.seats - a.seats ||
        a.code.localeCompare(b.code),
    );
  const staleCodes = all.filter((listing) => !fresh(listing)).map((listing) => listing.code);
  const probeCodes = rooms
    .filter((listing) => now - listing.updatedAt >= PROBE_AFTER_MS)
    .sort((a, b) => a.updatedAt - b.updatedAt)
    .slice(0, MAX_PROBES_PER_TICK)
    .map((listing) => listing.code);
  const overflowCodes =
    all.length <= MAX_LISTINGS
      ? []
      : [...all]
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, all.length - MAX_LISTINGS)
          .map((listing) => listing.code);

  return {
    rooms,
    openLobbies,
    liveGames,
    staleCodes,
    probeCodes,
    overflowCodes,
    nextTickAt: all.length > 0 ? now + DIRECTORY_TICK_MS : null,
  };
}
