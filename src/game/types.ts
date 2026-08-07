// Core data types. These mirror the shapes of the static JSON in /public/data
// (originally reverse-engineered from 322-0.app — see docs/FINDINGS.md).

export type Role = "safelane" | "mid" | "offlane" | "support";
export type SlotId = "safelane" | "mid" | "offlane" | "support1" | "support2";

export interface EventInfo {
  id: string;
  name: string;
  short: string;
  type: "ti" | "major";
  year: number;
  patch: string;
  formats: string[]; // "valve_legacy" | "standard"
}

export interface PackPlayer {
  steamId: number;
  nickname: string;
  role: Role;
  ovr: number;
  impact: number;
  economy: number;
  reliability: number;
  games: number;
}

export interface Pack {
  id: string;
  eventId: string;
  teamId: number;
  teamName: string;
  tag: string | null;
  logoId: string;
  placement: number | null;
  players: PackPlayer[];
  signatureHeroes: number[];
}

export interface Hero {
  id: number;
  name: string;
  picture: string;
}

/** steamId -> heroId -> { games, winrate } */
export type PlayerHeroStats = Record<string, Record<string, { games: number; winrate: number }>>;

/** Groups of 2-5 players who played together. */
export interface SynergyGroup {
  ids: number[];
  games: number;
  winrate: number;
}

export interface DataBundle {
  events: EventInfo[];
  packs: Pack[];
  heroes: Hero[];
  playerHeroStats: PlayerHeroStats;
  squadSynergy: SynergyGroup[];
}

// ---- Run configuration ----

export type GameFormat = "valve_legacy" | "standard";
/**
 * How player cards are built:
 *  - "event":  one card per player per event (original 322-0 behaviour)
 *  - "career": one card per player, stats averaged over all events (weighted by games)
 *  - "peak":   one card per player, best event blended with the events right before/after
 */
export type CardMode = "event" | "career" | "peak";
export type HeroAlloc = "auto" | "manual";

export interface RunConfig {
  format: GameFormat;
  cardMode: CardMode;
  rerolls: number; // difficulty: hard 0 / easy 1 / smurfing 2
  heroAlloc: HeroAlloc;
}

/** A drafted player on the user's roster (card mode already applied). */
export interface RosterPlayer extends PackPlayer {
  team: string; // team shown on the card
  eventId: string | null; // null for deduped (career/peak) cards
}

export interface TeamStrength {
  overall: number;
  base: number;
  heroBonus: number;
  chemBonus: number;
  assignment: { heroId: number | null; games: number }[]; // parallel to roster order
  chemEdges: { i: number; j: number; games: number; bonus: number }[];
  chemTop: { names: string[]; games: number; bonus: number }[];
}

// ---- Tournament ----

export interface SimTeam {
  id: string;
  name: string;
  strength: number;
  isUser: boolean;
  /** Human owner of this team ("solo" in single-player, a playerId in versus); null = AI. */
  ownerId: string | null;
}

export interface GroupGameRow {
  id: string;
  group: string;
  a: SimTeam;
  b: SimTeam;
  games: ("a" | "b")[]; // Bo2 series
}

export interface GroupStanding {
  team: SimTeam;
  wins: number;
  losses: number;
}

export interface BracketMatch {
  id: string;
  a: SimTeam;
  b: SimTeam;
  scoreA: number;
  scoreB: number;
  winner: SimTeam;
  loser: SimTeam;
  bestOf: number;
  games: ("a" | "b")[];
}

export interface BracketRound {
  name: string;
  matches: BracketMatch[];
}

export interface FinalStanding {
  place: number;
  label: string;
  team: SimTeam;
}

/** Per-human-team tournament summary, keyed by ownerId in SimResult. */
export interface OwnerStats {
  place: number;
  label: string;
  undefeated: boolean;
  flawlessGroup: boolean;
  gamesWon: number;
  gamesLost: number;
}

export interface SimResult {
  seed: number;
  groupAssign: { team: SimTeam; group: "A" | "B" }[];
  groupMatches: GroupGameRow[];
  groups: { A: GroupStanding[]; B: GroupStanding[] };
  rounds: BracketRound[];
  standings: FinalStanding[];
  champion: SimTeam;
  ownerStats: Record<string, OwnerStats>;
  userPlace: number;
  userLabel: string;
  userUndefeated: boolean; // champion without losing a single game — a true 322-0
  flawlessGroup: boolean;
  gamesWon: number;
  gamesLost: number;
}

export interface RunRecord {
  id: number;
  date: number;
  place: number;
  label: string;
  overall: number;
  undefeated: boolean;
  flawlessGroup: boolean;
  gamesWon: number;
  gamesLost: number;
  champion: string;
  config: RunConfig;
  roster: { nickname: string; steamId: number; role: Role; ovr: number; heroId: number | null }[];
}
