import type { DrawnPack, Slots } from "../game/draft";
import type {
  CardMode,
  GameFormat,
  HeroAlloc,
  RosterPlayer,
  SimTeam,
  TeamStrength,
} from "../game/types";

// ---------------------------------------------------------------------------
// Versus wire contract. Everything in this game is public information (open
// packs, open boards, open shelf), so one snapshot type serves every seat.
// ---------------------------------------------------------------------------

export type Phase = "lobby" | "drafting" | "assembled" | "broadcasting" | "done";

export interface MpConfig {
  format: GameFormat;
  cardMode: CardMode;
  heroAlloc: HeroAlloc;
  timerSecs: 7 | 15 | 25 | null;
  mulligans: 0 | 1 | 2;
}

export const DEFAULT_MP_CONFIG: MpConfig = {
  format: "valve_legacy",
  cardMode: "career",
  heroAlloc: "auto",
  timerSecs: 15,
  mulligans: 1,
};

export const MIN_SEATS = 2;
export const MAX_SEATS = 8;
export const DENIES_PER_GAME = 1;

export interface Seat {
  playerId: string;
  name: string;
  connected: boolean;
  isHost: boolean;
}

export type CardRef = { kind: "player"; steamId: number } | { kind: "hero"; heroId: number };

export type DeniedCard =
  | { kind: "player"; player: RosterPlayer }
  | { kind: "hero"; heroId: number };

/** A seat's draft action, as consumed by the engine reducer. */
export type Action =
  | { type: "pick"; card: CardRef }
  | { type: "deny"; card: CardRef }
  | { type: "pass" }
  | { type: "mulligan" };

export interface Board {
  slots: Slots;
  heroes: number[];
}

export interface DraftPublic {
  packSeq: number;
  /** Spread number — what the UI shows as the round. */
  roundSeq: number;
  openerSeat: number;
  turnSeat: number | null;
  /** Epoch ms the current turn autopicks, or null (timer off / no turn). */
  turnDeadline: number | null;
  /** The open spread (1 pack, 2 for 5+ seats); taken/denied cards removed. */
  currentPacks: DrawnPack[];
  boards: Board[]; // parallel to seats
  takenSteamIds: number[];
  deniedShelf: { card: DeniedCard; bySeat: number; packSeq: number }[];
  mulligansLeft: number[];
  deniesLeft: number[];
}

export interface RoomSnapshot {
  phase: Phase;
  config: MpConfig;
  seats: Seat[];
  draft: DraftPublic | null;
  // assembled →
  strengths: TeamStrength[] | null; // parallel to seats
  heroAssignments: Record<string, number>[] | null; // parallel to seats, steamId → heroId
  field: SimTeam[] | null;
  simSeed: number | null;
  // broadcasting →
  beat: { idx: number; playing: boolean } | null;
}

export type ClientMsg =
  | { t: "configure"; config: Partial<MpConfig> } // host, lobby only
  | { t: "rename"; name: string } // own seat, lobby only
  | { t: "spectate" } // vacate own seat, lobby only
  | { t: "takeSeat" } // claim an open seat, lobby only
  | { t: "start" } // host, needs MIN_SEATS+
  | { t: "pick"; card: CardRef }
  | { t: "deny"; card: CardRef }
  | { t: "pass" }
  | { t: "mulligan" }
  | { t: "assignHero"; steamId: number; heroId: number } // own board, assembled/manual only
  | { t: "play" } // host, assembled → broadcasting
  | { t: "beat"; action: "pause" | "resume" | "skip" }; // host

export type ServerMsg =
  | { t: "snapshot"; room: RoomSnapshot }
  | { t: "error"; code: string; msg: string };

export const NAME_MAX = 30;
export const DEFAULT_NAME = "Sin Nombre";

/**
 * The boards rail marks your own team with a trailing "(you)". A team that
 * puts it in its own name reads as everyone's own board, so it's not allowed
 * — matched loosely enough that case and padding don't get around it.
 */
const YOU_TAG = /\(\s*you\s*\)/i;

export function hasYouTag(raw: string): boolean {
  return YOU_TAG.test(raw);
}

/** Trim, strip the impersonation tag, collapse whitespace, cap length. */
export function sanitizeName(raw: string): string {
  return raw
    .replace(new RegExp(YOU_TAG.source, "gi"), " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);
}

/** 5-char room code from an unambiguous alphabet. */
export function makeRoomCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
