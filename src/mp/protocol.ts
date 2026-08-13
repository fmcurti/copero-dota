import type { DrawnPack, Slots } from "../game/draft";
import type {
  CardMode,
  GameFormat,
  HeroAlloc,
  RosterPlayer,
  SimTeam,
  TeamStrength,
} from "../game/types";
import type { Action, Board, CardRef, DeniedCard, DraftMode, EngineState } from "./engine";

// ---------------------------------------------------------------------------
// Versus wire contract. Everything in this game is public information (open
// packs, open boards, open shelf), so one snapshot type serves every seat.
// ---------------------------------------------------------------------------

export type Phase = "lobby" | "drafting" | "assembled" | "broadcasting" | "done";

/**
 * Who can find a room without being handed its code:
 *  - private     — nobody; the code is the only way in (the default).
 *  - spectatable — hidden while it fills up, listed to watch once it starts.
 *  - public      — listed as an open lobby, and watchable once it starts.
 */
export type RoomVisibility = "private" | "spectatable" | "public";

export interface MpConfig {
  format: GameFormat;
  cardMode: CardMode;
  heroAlloc: HeroAlloc;
  /** classic = one shared spread, turns around the table; turbo = every seat
   *  holds its own pack and picks at once, leftovers chain to the next seat. */
  draftMode: DraftMode;
  timerSecs: 7 | 15 | 25 | null;
  mulligans: 0 | 1 | 2;
  visibility: RoomVisibility;
}

export const DEFAULT_MP_CONFIG: MpConfig = {
  format: "valve_legacy",
  cardMode: "career",
  heroAlloc: "auto",
  draftMode: "classic",
  timerSecs: 15,
  mulligans: 1,
  visibility: "private",
};

export const MIN_SEATS = 2;
export const MAX_SEATS = 8;

export const MAX_WIN_PHRASES = 8;
export const MAX_WIN_PHRASE_LEN = 120;

/** Shared client/server cleanup for victory phrases (single line, capped). */
export function sanitizeWinPhrases(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .filter((p): p is string => typeof p === "string")
    .map((p) => p.replace(/\s+/g, " ").trim().slice(0, MAX_WIN_PHRASE_LEN))
    .filter(Boolean)
    .slice(0, MAX_WIN_PHRASES);
}

export const MAX_CHAT_LEN = 200;
export const CHAT_LOG_CAP = 50;

export interface ChatEntry {
  /** Monotonic per room, survives the log cap — powers unread badges. */
  seq: number;
  /** Kept alongside the name so own messages stay marked after a kick. */
  playerId: string;
  /** Seat name at send time — attribution survives unseating and renames. */
  name: string;
  text: string;
  /** Epoch ms, server clock. */
  at: number;
}

/** Shared client/server cleanup for chat messages (single line, capped). */
export function sanitizeChatText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, MAX_CHAT_LEN);
}

export interface Seat {
  playerId: string;
  name: string;
  connected: boolean;
  isHost: boolean;
}

export type DraftPublic = Pick<
  EngineState,
  | "mode"
  | "packSeq"
  | "roundSeq"
  | "openerSeat"
  | "turnSeat"
  | "currentPacks"
  | "packDealtTo"
  | "packPassCount"
  | "boards"
  | "takenSteamIds"
  | "deniedShelf"
  | "mulligansLeft"
  | "deniesLeft"
> & {
  /** Epoch ms the current turn autopicks, or null (timer off / no turn). */
  turnDeadline: number | null;
  /** Turbo: each seat's autopick deadline for the pack in its hands. */
  turnDeadlines: (number | null)[] | null;
};

/**
 * A ranked room's public clock: when the lobby auto-starts the draft and when
 * the assembled screen auto-plays. Each deadline nulls once it fires. Casual
 * rooms carry null — a non-null value is also how clients know they are in a
 * ranked room (no host powers, seats locked).
 */
export interface RankedPublic {
  startAt: number | null;
  playAt: number | null;
}

export interface RoomSnapshot {
  phase: Phase;
  config: MpConfig;
  ranked: RankedPublic | null;
  seats: Seat[];
  draft: DraftPublic | null;
  // assembled →
  strengths: TeamStrength[] | null; // parallel to seats
  heroAssignments: Record<string, number>[] | null; // parallel to seats, steamId → heroId
  field: SimTeam[] | null;
  simSeed: number | null;
  // broadcasting →
  /** `count` = the server's beat total, a desync tripwire for the client. */
  beat: { idx: number; playing: boolean; count: number } | null;
  /**
   * The victory phrase for the current taunt beat, if any. Phrases live only
   * on the server — this is the single moment one is ever sent to clients.
   */
  taunt: { ownerId: string; phrase: string } | null;
  /** Bounded message log (last CHAT_LOG_CAP). */
  chat: ChatEntry[];
}

export type ClientMsg =
  | { t: "configure"; config: Partial<MpConfig> } // host, lobby only
  | { t: "rename"; name: string } // own seat, lobby only
  | { t: "phrases"; phrases: string[] } // own seat, any phase
  | { t: "chat"; text: string } // own seat, any phase

  | { t: "spectate" } // vacate own seat, lobby only
  | { t: "takeSeat" } // claim an open seat, lobby only
  | { t: "kick"; playerId: string } // host, lobby only — unseats, no ban
  | { t: "start" } // host, needs MIN_SEATS+
  | { t: "draft"; action: Action }
  | { t: "assignHero"; steamId: number; heroId: number } // own board, assembled/manual only
  | { t: "play" } // host, assembled → broadcasting
  | { t: "beat"; action: "pause" | "resume" | "skip" }; // host

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseCardRef(value: unknown): CardRef | null {
  if (!isRecord(value)) return null;
  if (value.kind === "player" && isId(value.steamId)) {
    return { kind: "player", steamId: value.steamId };
  }
  if (value.kind === "hero" && isId(value.heroId)) {
    return { kind: "hero", heroId: value.heroId };
  }
  return null;
}

function parseAction(value: unknown): Action | null {
  if (!isRecord(value)) return null;
  if (value.type === "pass" || value.type === "mulligan") return { type: value.type };
  if (value.type !== "pick" && value.type !== "deny") return null;
  const card = parseCardRef(value.card);
  return card ? { type: value.type, card } : null;
}

function parseConfig(value: unknown): Partial<MpConfig> | null {
  if (!isRecord(value)) return null;
  const config: Partial<MpConfig> = {};
  if (value.format !== undefined) {
    if (value.format !== "standard" && value.format !== "valve_legacy") return null;
    config.format = value.format;
  }
  if (value.cardMode !== undefined) {
    if (value.cardMode !== "career" && value.cardMode !== "peak" && value.cardMode !== "event")
      return null;
    config.cardMode = value.cardMode;
  }
  if (value.heroAlloc !== undefined) {
    if (value.heroAlloc !== "auto" && value.heroAlloc !== "manual") return null;
    config.heroAlloc = value.heroAlloc;
  }
  if (value.draftMode !== undefined) {
    if (value.draftMode !== "classic" && value.draftMode !== "turbo") return null;
    config.draftMode = value.draftMode;
  }
  if (value.timerSecs !== undefined) {
    if (value.timerSecs !== 7 && value.timerSecs !== 15 && value.timerSecs !== 25 && value.timerSecs !== null)
      return null;
    config.timerSecs = value.timerSecs;
  }
  if (value.mulligans !== undefined) {
    if (value.mulligans !== 0 && value.mulligans !== 1 && value.mulligans !== 2) return null;
    config.mulligans = value.mulligans;
  }
  if (value.visibility !== undefined) {
    if (
      value.visibility !== "private" &&
      value.visibility !== "spectatable" &&
      value.visibility !== "public"
    )
      return null;
    config.visibility = value.visibility;
  }
  return config;
}

/** Validate an untrusted decoded WebSocket payload at the protocol seam. */
export function parseClientMsg(value: unknown): ClientMsg | null {
  if (!isRecord(value) || typeof value.t !== "string") return null;
  switch (value.t) {
    case "configure": {
      const config = parseConfig(value.config);
      return config ? { t: "configure", config } : null;
    }
    case "rename":
      return typeof value.name === "string" ? { t: "rename", name: value.name } : null;
    case "chat":
      return typeof value.text === "string" ? { t: "chat", text: value.text } : null;
    case "phrases":
      return Array.isArray(value.phrases) && value.phrases.every((p) => typeof p === "string")
        ? { t: "phrases", phrases: value.phrases }
        : null;
    case "spectate":
    case "takeSeat":
    case "start":
    case "play":
      return { t: value.t };
    case "kick":
      return typeof value.playerId === "string" ? { t: "kick", playerId: value.playerId } : null;
    case "draft": {
      const action = parseAction(value.action);
      return action ? { t: "draft", action } : null;
    }
    case "assignHero":
      return isId(value.steamId) && isId(value.heroId)
        ? { t: "assignHero", steamId: value.steamId, heroId: value.heroId }
        : null;
    case "beat":
      return value.action === "pause" || value.action === "resume" || value.action === "skip"
        ? { t: "beat", action: value.action }
        : null;
    default:
      return null;
  }
}

export type ServerMsg =
  | { t: "snapshot"; room: RoomSnapshot }
  | { t: "error"; code: string; msg: string; fatal?: boolean };

const isPhase = (value: unknown): value is Phase =>
  value === "lobby" ||
  value === "drafting" ||
  value === "assembled" ||
  value === "broadcasting" ||
  value === "done";

const isConfig = (value: unknown): value is MpConfig => {
  if (!isRecord(value)) return false;
  return (
    (value.format === "standard" || value.format === "valve_legacy") &&
    (value.cardMode === "career" || value.cardMode === "peak" || value.cardMode === "event") &&
    (value.heroAlloc === "auto" || value.heroAlloc === "manual") &&
    (value.draftMode === "classic" || value.draftMode === "turbo") &&
    (value.timerSecs === 7 || value.timerSecs === 15 || value.timerSecs === 25 || value.timerSecs === null) &&
    (value.mulligans === 0 || value.mulligans === 1 || value.mulligans === 2) &&
    (value.visibility === "private" || value.visibility === "spectatable" || value.visibility === "public")
  );
};

const isSeat = (value: unknown): value is Seat =>
  isRecord(value) &&
  typeof value.playerId === "string" &&
  typeof value.name === "string" &&
  typeof value.connected === "boolean" &&
  typeof value.isHost === "boolean";

const isRosterPlayer = (value: unknown): value is RosterPlayer =>
  isRecord(value) &&
  isId(value.steamId) &&
  typeof value.nickname === "string" &&
  (value.role === "safelane" ||
    value.role === "mid" ||
    value.role === "offlane" ||
    value.role === "support") &&
  isFiniteNumber(value.ovr) &&
  isFiniteNumber(value.impact) &&
  isFiniteNumber(value.economy) &&
  isFiniteNumber(value.reliability) &&
  isId(value.games) &&
  typeof value.team === "string" &&
  (typeof value.eventId === "string" || value.eventId === null);

const isDrawnPack = (value: unknown): value is DrawnPack =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.teamName === "string" &&
  typeof value.eventId === "string" &&
  (value.placement === null || isId(value.placement)) &&
  Array.isArray(value.players) &&
  value.players.every(isRosterPlayer) &&
  Array.isArray(value.heroes) &&
  value.heroes.every(isId);

const isSlots = (value: unknown): value is Slots =>
  isRecord(value) &&
  ["safelane", "mid", "offlane", "support1", "support2"].every(
    (slot) => value[slot] === null || isRosterPlayer(value[slot]),
  );

const isBoard = (value: unknown): value is Board =>
  isRecord(value) &&
  isSlots(value.slots) &&
  Array.isArray(value.heroes) &&
  value.heroes.every(isId);

const isDeniedCard = (value: unknown): value is DeniedCard =>
  isRecord(value) &&
  ((value.kind === "player" && isRosterPlayer(value.player)) ||
    (value.kind === "hero" && isId(value.heroId)));

function isDraftPublic(value: unknown): value is DraftPublic {
  if (!isRecord(value)) return false;
  if (value.mode !== "classic" && value.mode !== "turbo") return false;
  if (!isId(value.packSeq) || !isId(value.roundSeq) || !isId(value.openerSeat)) return false;
  if (value.turnSeat !== null && !isId(value.turnSeat)) return false;
  if (value.turnDeadline !== null && !isId(value.turnDeadline)) return false;
  if (
    value.turnDeadlines !== null &&
    (!Array.isArray(value.turnDeadlines) ||
      !value.turnDeadlines.every((deadline) => deadline === null || isId(deadline)))
  )
    return false;
  if (!Array.isArray(value.currentPacks) || !value.currentPacks.every(isDrawnPack)) return false;
  if (!Array.isArray(value.packDealtTo) || !value.packDealtTo.every(isId)) return false;
  if (!Array.isArray(value.packPassCount) || !value.packPassCount.every(isId)) return false;
  if (!Array.isArray(value.boards) || !value.boards.every(isBoard)) return false;
  if (!Array.isArray(value.takenSteamIds) || !value.takenSteamIds.every(isId)) return false;
  if (
    !Array.isArray(value.deniedShelf) ||
    !value.deniedShelf.every(
      (entry) =>
        isRecord(entry) &&
        isDeniedCard(entry.card) &&
        isId(entry.bySeat) &&
        isId(entry.packSeq),
    )
  )
    return false;
  if (!Array.isArray(value.mulligansLeft) || !value.mulligansLeft.every(isId)) return false;
  if (!Array.isArray(value.deniesLeft) || !value.deniesLeft.every(isId)) return false;

  const seats = value.boards.length;
  if (seats === 0 || value.openerSeat >= seats) return false;
  if (value.turnSeat !== null && value.turnSeat >= seats) return false;
  if (value.mulligansLeft.length !== seats || value.deniesLeft.length !== seats) return false;
  if (value.turnDeadlines !== null && value.turnDeadlines.length !== seats) return false;
  if (
    value.mode === "turbo" &&
    (value.packDealtTo.length !== value.currentPacks.length ||
      value.packPassCount.length !== value.currentPacks.length ||
      value.packDealtTo.some((seat) => seat >= seats))
  )
    return false;
  return true;
}

const isTeamStrength = (value: unknown): value is TeamStrength =>
  isRecord(value) &&
  isFiniteNumber(value.overall) &&
  isFiniteNumber(value.base) &&
  isFiniteNumber(value.heroBonus) &&
  isFiniteNumber(value.chemBonus) &&
  Array.isArray(value.assignment) &&
  value.assignment.every(
    (entry) =>
      isRecord(entry) &&
      (entry.heroId === null || isId(entry.heroId)) &&
      isId(entry.games),
  ) &&
  Array.isArray(value.chemEdges) &&
  value.chemEdges.every(
    (edge) =>
      isRecord(edge) &&
      isId(edge.i) &&
      isId(edge.j) &&
      isId(edge.games) &&
      isFiniteNumber(edge.bonus),
  ) &&
  Array.isArray(value.chemTop) &&
  value.chemTop.every(
    (group) =>
      isRecord(group) &&
      Array.isArray(group.names) &&
      group.names.every((name) => typeof name === "string") &&
      isId(group.games) &&
      isFiniteNumber(group.bonus),
  );

const isHeroAssignment = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every(isId);

const isSimTeam = (value: unknown): value is SimTeam =>
  isRecord(value) &&
  typeof value.id === "string" &&
  typeof value.name === "string" &&
  isFiniteNumber(value.strength) &&
  typeof value.isUser === "boolean" &&
  (typeof value.ownerId === "string" || value.ownerId === null) &&
  (value.luck === undefined ||
    (isRecord(value.luck) &&
      isFiniteNumber(value.luck.chance) &&
      value.luck.chance >= 0 &&
      value.luck.chance <= 1 &&
      typeof value.luck.label === "string"));

const isChatEntry = (value: unknown): value is ChatEntry =>
  isRecord(value) &&
  isId(value.seq) &&
  typeof value.playerId === "string" &&
  typeof value.name === "string" &&
  typeof value.text === "string" &&
  isId(value.at);

function isRoomSnapshot(value: unknown): value is RoomSnapshot {
  if (!isRecord(value)) return false;
  if (!isPhase(value.phase) || !isConfig(value.config)) return false;
  if (
    value.ranked !== null &&
    (!isRecord(value.ranked) ||
      (value.ranked.startAt !== null && !isId(value.ranked.startAt)) ||
      (value.ranked.playAt !== null && !isId(value.ranked.playAt)))
  )
    return false;
  if (!Array.isArray(value.seats) || !value.seats.every(isSeat)) return false;
  if (value.draft !== null && !isDraftPublic(value.draft)) return false;
  if (
    value.strengths !== null &&
    (!Array.isArray(value.strengths) || !value.strengths.every(isTeamStrength))
  )
    return false;
  if (
    value.heroAssignments !== null &&
    (!Array.isArray(value.heroAssignments) || !value.heroAssignments.every(isHeroAssignment))
  )
    return false;
  if (
    value.field !== null &&
    (!Array.isArray(value.field) || value.field.length !== 18 || !value.field.every(isSimTeam))
  )
    return false;
  if (value.simSeed !== null && !isId(value.simSeed)) return false;
  if (
    value.beat !== null &&
    (!isRecord(value.beat) ||
      !isId(value.beat.idx) ||
      typeof value.beat.playing !== "boolean" ||
      !isId(value.beat.count))
  )
    return false;
  if (
    value.taunt !== null &&
    (!isRecord(value.taunt) ||
      typeof value.taunt.ownerId !== "string" ||
      typeof value.taunt.phrase !== "string")
  )
    return false;
  if (!Array.isArray(value.chat) || !value.chat.every(isChatEntry)) return false;
  if (value.draft !== null && value.draft.boards.length !== value.seats.length) return false;
  if (value.strengths !== null && value.strengths.length !== value.seats.length) return false;
  if (
    value.heroAssignments !== null &&
    value.heroAssignments.length !== value.seats.length
  )
    return false;
  return true;
}

/** Validate an untrusted decoded server frame at the protocol seam. */
export function parseServerMsg(value: unknown): ServerMsg | null {
  if (!isRecord(value)) return null;
  if (value.t === "snapshot") {
    return isRoomSnapshot(value.room) ? { t: "snapshot", room: value.room } : null;
  }
  if (value.t === "error") {
    return typeof value.code === "string" &&
      typeof value.msg === "string" &&
      (value.fatal === undefined || typeof value.fatal === "boolean")
      ? { t: "error", code: value.code, msg: value.msg, ...(value.fatal ? { fatal: true } : {}) }
      : null;
  }
  return null;
}

export const NAME_MAX = 30;
export const DEFAULT_NAME = "Sin Nombre";

/**
 * The UI reserves "(you)" as a self marker. A team that puts it in its own
 * name can still read as everyone's own board, so it is not allowed — matched
 * loosely enough that case and padding do not get around it.
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

/** Room code from an unambiguous alphabet — 5 chars for casual rooms. */
export function makeRoomCode(length = 5): string {
  const alphabet = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  let code = "";
  for (let i = 0; i < length; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}
