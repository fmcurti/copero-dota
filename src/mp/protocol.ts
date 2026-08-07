import type { DrawnPack, Slots } from "../game/draft";
import type { CardMode, GameFormat, RosterPlayer, SimTeam, TeamStrength } from "../game/types";

// ---------------------------------------------------------------------------
// Versus wire contract. Everything in this game is public information (open
// packs, open boards, open shelf), so one snapshot type serves every seat.
// ---------------------------------------------------------------------------

export type Phase = "lobby" | "drafting" | "assembled" | "broadcasting" | "done";

export interface MpConfig {
  format: GameFormat;
  cardMode: CardMode;
  timerSecs: 7 | 15 | 25 | null;
  mulligans: 0 | 1 | 2;
}

export const DEFAULT_MP_CONFIG: MpConfig = {
  format: "valve_legacy",
  cardMode: "career",
  timerSecs: 15,
  mulligans: 1,
};

export const MIN_SEATS = 2;
export const MAX_SEATS = 4;
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
  openerSeat: number;
  turnSeat: number | null;
  /** Epoch ms the current turn autopicks, or null (timer off / no turn). */
  turnDeadline: number | null;
  /** Cards already taken or denied are removed from the pack. */
  currentPack: DrawnPack | null;
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
  field: SimTeam[] | null;
  simSeed: number | null;
  // broadcasting →
  beat: { idx: number; playing: boolean } | null;
}

export type ClientMsg =
  | { t: "configure"; config: Partial<MpConfig> } // host, lobby only
  | { t: "rename"; name: string } // own seat, lobby only
  | { t: "start" } // host, needs MIN_SEATS+
  | { t: "pick"; card: CardRef }
  | { t: "deny"; card: CardRef }
  | { t: "pass" }
  | { t: "mulligan" }
  | { t: "play" } // host, assembled → broadcasting
  | { t: "beat"; action: "pause" | "resume" | "skip" }; // host

export type ServerMsg =
  | { t: "snapshot"; room: RoomSnapshot }
  | { t: "error"; code: string; msg: string };

/** 5-char room code from an unambiguous alphabet. */
export function makeRoomCode(): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
