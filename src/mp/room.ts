import { pickTaunt, tauntOwner, type Beat } from "../game/beats";
import { generateFieldMulti } from "../game/field";
import { luckTraitFor } from "../game/luck";
import { seeded, type Rng } from "../game/rng";
import { computeStrength, swapHeroAssignment } from "../game/strength";
import type { DataBundle, Pack, SimResult, SimTeam, TeamStrength } from "../game/types";
import { autopick } from "./autopick";
import {
  applyAction,
  boardRoster,
  createDraft,
  openSpread,
  type EngineState,
} from "./engine";
import {
  DEFAULT_MP_CONFIG,
  MAX_SEATS,
  MIN_SEATS,
  hasYouTag,
  sanitizeName,
  sanitizeWinPhrases,
  type ClientMsg,
  type MpConfig,
  type Phase,
  type RoomSnapshot,
  type Seat,
} from "./protocol";
import { nameTaken, seatPlayer, unseatPlayer } from "./seating";

// ---------------------------------------------------------------------------
// The Room state machine — a pure reducer over the whole room, the same shape
// the draft engine uses for a single spread. The host (the Durable Object in
// production, a plain test harness in vitest) owns sockets, storage and the
// alarm slot; this module owns every rule: who may sit, when the draft
// advances, what a timeout does, how the reveal ticks, when the room dies.
//
//   roomReducer(state, event, ctx) → { state, changed, reply?, conns?, ... }
//
// The reducer never mutates its input (it works on a clone), never does I/O,
// and never reads a clock or RNG it wasn't handed — so a full session replays
// deterministically from (draftSeed, events).
// ---------------------------------------------------------------------------

export interface RoomState {
  phase: Phase;
  config: MpConfig;
  seats: Seat[];
  engine: EngineState | null;
  turnDeadline: number | null;
  strengths: TeamStrength[] | null;
  heroAssignments: Record<string, number>[] | null;
  fieldSeed: number | null;
  field: SimTeam[] | null;
  simSeed: number | null;
  beat: { idx: number; playing: boolean } | null;
  /** Epoch ms the current beat advances, while the reveal is playing. */
  beatDeadline: number | null;
  /** Every spread's pack RNG derives from this — a draft replays from (seed,
   *  actions). Null only on rooms that started drafting before it existed. */
  draftSeed: number | null;
  /** Victory phrases by playerId — server-side secret until a taunt beat fires. */
  phrases: Record<string, string[]>;
}

export const freshRoom = (): RoomState => ({
  phase: "lobby",
  config: { ...DEFAULT_MP_CONFIG },
  seats: [],
  engine: null,
  turnDeadline: null,
  strengths: null,
  heroAssignments: null,
  fieldSeed: null,
  field: null,
  simSeed: null,
  beat: null,
  beatDeadline: null,
  draftSeed: null,
  phrases: {},
});

export const CLEANUP_MS = 60 * 60 * 1000;

/** Everything the room may happen to. Connections and messages carry the
 *  identity the host resolved from the socket; the reducer never sees a socket. */
export type RoomEvent =
  | { type: "connect"; playerId: string; name: string; prefersSpectator: boolean }
  | { type: "message"; playerId: string; connName: string; msg: ClientMsg }
  | { type: "close" }
  | { type: "alarm" };

/** Deterministic sim + beat schedule; the host memoizes it per simSeed. */
export type SimProvider = () => { beats: Beat[]; result: SimResult };

/** The world as the reducer is allowed to see it. */
export interface RoomCtx {
  now: number;
  /** Fresh randomness — used only to roll seeds; play derives from the seeds. */
  random: Rng;
  /** Card pool + stat bundle; the host pre-loads it when needsData() says so. */
  data: { pool: Pack[]; bundle: DataBundle } | null;
  sim: SimProvider;
  /** playerIds with at least one open connection right now. */
  connectedIds: () => Set<string>;
}

/** A per-player connection-state patch the host fans out to that player's sockets. */
export interface ConnPatch {
  playerId: string;
  name?: string;
  spectating?: boolean;
}

export interface RoomResult {
  state: RoomState;
  /** State changed — persist, broadcast a snapshot, refresh the directory. */
  changed: boolean;
  /** Error reply to the connection that sent the event. */
  reply?: { code: string; msg: string };
  conns?: ConnPatch[];
  /** Targeted error to another player's connections (e.g. a kick notice). */
  notify?: { playerId: string; code: string; msg: string }[];
  /** The room is over and empty: wipe storage and start fresh. */
  purge?: boolean;
}

/** Events that need ctx.data loaded before they can be reduced. */
export function needsData(state: RoomState, event: RoomEvent): boolean {
  if (event.type === "alarm") return state.phase === "drafting";
  if (event.type !== "message") return false;
  const t = event.msg?.t;
  return (
    t === "start" || t === "pick" || t === "deny" || t === "pass" || t === "mulligan" ||
    t === "assignHero"
  );
}

/**
 * The single owner of the DO's one alarm slot: turn timer while drafting,
 * beat ticker while the reveal plays, self-cleanup once done and empty.
 * The host reconciles storage to this after every event.
 */
export function nextAlarm(state: RoomState, opts: { now: number; empty: boolean }): number | null {
  if (state.phase === "drafting") return state.turnDeadline;
  if (state.phase === "broadcasting" && state.beat?.playing) return state.beatDeadline;
  if (state.phase === "done" && opts.empty) return opts.now + CLEANUP_MS;
  return null;
}

export function roomReducer(state: RoomState, event: RoomEvent, ctx: RoomCtx): RoomResult {
  // Work on a clone: a half-applied event can never corrupt the caller's state.
  const r = structuredClone(state);
  switch (event.type) {
    case "connect":
      return onConnect(r, event);
    case "close":
      return onClose(r, ctx);
    case "alarm":
      return onAlarm(r, ctx);
    case "message":
      return onMessage(r, event, ctx);
  }
}

const err = (state: RoomState, code: string, msg: string): RoomResult => ({
  state,
  changed: false,
  reply: { code, msg },
});

// ---- connections ----

function onConnect(
  r: RoomState,
  ev: { playerId: string; name: string; prefersSpectator: boolean },
): RoomResult {
  const { playerId, name, prefersSpectator } = ev;
  const seatIdx = r.seats.findIndex((s) => s.playerId === playerId);
  let conn: ConnPatch;
  if (seatIdx >= 0 && prefersSpectator && r.phase === "lobby") {
    conn = { playerId, name: r.seats[seatIdx].name, spectating: true };
    r.seats = unseatPlayer(r.seats, playerId);
  } else if (seatIdx >= 0) {
    // Reattach only — never clobber the seat name (it may have been renamed
    // in the lobby, and reconnects replay the stale query-string name).
    const savedName = r.seats[seatIdx].name;
    r.seats = seatPlayer(r.seats, playerId, name);
    conn = { playerId, name: savedName, spectating: false };
  } else if (!prefersSpectator && r.phase === "lobby") {
    const nextSeats = seatPlayer(r.seats, playerId, name);
    const seated = nextSeats.length > r.seats.length;
    r.seats = nextSeats;
    conn = { playerId, name, spectating: !seated };
  } else {
    conn = { playerId, name, spectating: true };
  }
  return { state: r, changed: true, conns: [conn] };
}

function onClose(r: RoomState, ctx: RoomCtx): RoomResult {
  const ids = ctx.connectedIds();
  let changed = false;
  for (const s of r.seats) {
    const now = ids.has(s.playerId);
    if (s.connected !== now) {
      s.connected = now;
      changed = true;
    }
  }
  return { state: r, changed };
}

// ---- the one alarm: turn timeout / beat ticker / cleanup ----

function onAlarm(r: RoomState, ctx: RoomCtx): RoomResult {
  if (r.phase === "drafting" && r.engine && r.engine.turnSeat != null) {
    if (r.turnDeadline == null || ctx.now < r.turnDeadline - 500) {
      return { state: r, changed: false }; // stale — the turn was re-armed
    }
    const seat = r.engine.turnSeat;
    const action = autopick(r.engine, seat, ctx.data!.bundle.playerHeroStats);
    const res = applyAction(r.engine, seat, action);
    if (!res.error) r.engine = res.state;
    openUntilTurn(r, ctx);
    afterDraftStep(r, ctx);
    return { state: r, changed: true };
  }
  if (r.phase === "broadcasting" && r.beat) {
    if (!r.beat.playing) return { state: r, changed: false };
    const { beats } = ctx.sim();
    const idx = Math.min(r.beat.idx + 1, beats.length - 1);
    r.beat = { idx, playing: idx < beats.length - 1 };
    if (idx >= beats.length - 1) {
      r.phase = "done";
      r.beatDeadline = null;
    } else {
      r.beatDeadline = ctx.now + beats[idx].ms;
    }
    return { state: r, changed: true };
  }
  if (r.phase === "done" && ctx.connectedIds().size === 0) {
    return { state: r, changed: false, purge: true };
  }
  return { state: r, changed: false };
}

// ---- messages ----

function onMessage(
  r: RoomState,
  ev: { playerId: string; connName: string; msg: ClientMsg },
  ctx: RoomCtx,
): RoomResult {
  const { playerId, connName, msg } = ev;

  if (msg.t === "spectate") {
    if (r.phase !== "lobby")
      return err(r, "bad-phase", "Seats are locked after the draft starts.");
    r.seats = unseatPlayer(r.seats, playerId);
    return { state: r, changed: true, conns: [{ playerId, spectating: true }] };
  }

  if (msg.t === "takeSeat") {
    if (r.phase !== "lobby")
      return err(r, "bad-phase", "Seats are locked after the draft starts.");
    const alreadySeated = r.seats.some((seat) => seat.playerId === playerId);
    if (!alreadySeated && r.seats.length >= MAX_SEATS)
      return err(r, "room-full", "Room is full.");
    r.seats = seatPlayer(r.seats, playerId, connName);
    return { state: r, changed: true, conns: [{ playerId, spectating: false }] };
  }

  const seat = r.seats.findIndex((s) => s.playerId === playerId);
  if (seat < 0) return err(r, "no-seat", "You are not seated in this room.");
  const isHost = r.seats[seat].isHost;

  if (msg.t === "kick") {
    if (!isHost) return err(r, "not-host", "Only the host can remove drafters.");
    if (r.phase !== "lobby")
      return err(r, "bad-phase", "Seats are locked after the draft starts.");
    if (msg.playerId === playerId)
      return err(r, "bad-target", "You can't remove yourself — spectate instead.");
    if (!r.seats.some((s) => s.playerId === msg.playerId))
      return err(r, "bad-target", "That drafter is not seated.");

    r.seats = unseatPlayer(r.seats, msg.playerId);
    // A kick is a nudge, not a ban: they stay connected as a spectator and
    // may claim a seat again. We deliberately keep no memory of it.
    return {
      state: r,
      changed: true,
      conns: [{ playerId: msg.playerId, spectating: true }],
      notify: [{ playerId: msg.playerId, code: "kicked", msg: "The host removed you from the lobby." }],
    };
  }

  switch (msg.t) {
    case "configure": {
      if (!isHost) return err(r, "not-host", "Only the host can configure.");
      if (r.phase !== "lobby") return err(r, "bad-phase", "Config is locked after start.");
      r.config = sanitizeConfig({ ...r.config, ...msg.config });
      return { state: r, changed: true };
    }
    case "rename": {
      if (r.phase !== "lobby") return err(r, "bad-phase", "Names are locked after start.");
      const raw = msg.name ?? "";
      if (hasYouTag(raw)) return err(r, "bad-name", "Names can't contain “(you)”.");
      const name = sanitizeName(raw);
      if (!name) return err(r, "bad-name", "Name cannot be empty.");
      if (nameTaken(r.seats, name, playerId))
        return err(r, "name-taken", `“${name}” is already taken in this room.`);
      r.seats[seat].name = name;
      return { state: r, changed: true, conns: [{ playerId, name }] };
    }
    case "phrases": {
      const phrases = sanitizeWinPhrases(msg.phrases);
      if (phrases.length) r.phrases[playerId] = phrases;
      else delete r.phrases[playerId];
      return { state: r, changed: true };
    }
    case "start": {
      if (!isHost) return err(r, "not-host", "Only the host can start.");
      if (r.phase !== "lobby") return err(r, "bad-phase", "Already started.");
      if (r.seats.length < MIN_SEATS)
        return err(r, "need-players", `Need at least ${MIN_SEATS} drafters.`);
      r.draftSeed = Math.floor(ctx.random() * 1e9);
      r.engine = createDraft(r.seats.length, {
        mulligans: r.config.mulligans,
        // The first opener is drawn, not handed to the host — from there the
        // usual rotation applies, so everyone still opens once per cycle.
        openerSeat: Math.floor(seeded(r.draftSeed, 0xc0ffee)() * r.seats.length),
      });
      r.phase = "drafting";
      openUntilTurn(r, ctx);
      afterDraftStep(r, ctx);
      return { state: r, changed: true };
    }
    case "pick":
    case "deny":
    case "pass":
    case "mulligan": {
      if (r.phase !== "drafting" || !r.engine)
        return err(r, "bad-phase", "No draft in progress.");
      const action =
        msg.t === "pick"
          ? ({ type: "pick", card: msg.card } as const)
          : msg.t === "deny"
            ? ({ type: "deny", card: msg.card } as const)
            : msg.t === "pass"
              ? ({ type: "pass" } as const)
              : ({ type: "mulligan" } as const);
      const res = applyAction(r.engine, seat, action);
      if (res.error) return err(r, res.error, `Illegal action (${res.error}).`);
      r.engine = res.state;
      openUntilTurn(r, ctx);
      afterDraftStep(r, ctx);
      return { state: r, changed: true };
    }
    case "assignHero": {
      if (r.phase !== "assembled" || !r.engine)
        return err(r, "bad-phase", "Hero assignments are already locked.");
      if (r.config.heroAlloc !== "manual")
        return err(r, "auto-assignment", "This room uses automatic hero assignment.");

      const board = r.engine.boards[seat];
      const roster = boardRoster(board);
      if (!roster.some((p) => p.steamId === msg.steamId))
        return err(r, "bad-player", "That player is not on your roster.");
      if (!board.heroes.includes(msg.heroId))
        return err(r, "bad-hero", "That hero is not on your roster.");

      const assignments = r.heroAssignments;
      if (!assignments?.[seat])
        return err(r, "no-assignment", "Hero assignments are unavailable.");
      assignments[seat] = swapHeroAssignment(assignments[seat], String(msg.steamId), msg.heroId);
      recomputeAssembled(r, ctx);
      return { state: r, changed: true };
    }
    case "play": {
      if (!isHost) return err(r, "not-host", "Only the host can play.");
      if (r.phase !== "assembled") return err(r, "bad-phase", "Not ready to play.");
      const { beats } = ctx.sim();
      r.phase = "broadcasting";
      r.beat = { idx: 0, playing: true };
      r.beatDeadline = ctx.now + beats[0].ms;
      return { state: r, changed: true };
    }
    case "beat": {
      if (!isHost) return err(r, "not-host", "Only the host controls the reveal.");
      if (r.phase !== "broadcasting" || !r.beat)
        return err(r, "bad-phase", "No broadcast running.");
      const { beats } = ctx.sim();
      if (msg.action === "pause") {
        r.beat.playing = false;
        r.beatDeadline = null;
      } else if (msg.action === "resume") {
        r.beat.playing = true;
        r.beatDeadline = ctx.now + beats[r.beat.idx].ms;
      } else {
        r.beat = { idx: beats.length - 1, playing: false };
        r.beatDeadline = null;
        r.phase = "done";
      }
      return { state: r, changed: true };
    }
    default:
      return err(r, "unknown", "Unknown message.");
  }
}

// ---- draft plumbing ----

/** The pack RNG for the next spread: replayable when the draft is seeded. */
function spreadRng(r: RoomState, e: EngineState, ctx: RoomCtx): Rng {
  return r.draftSeed != null ? seeded(r.draftSeed, e.roundSeq) : ctx.random;
}

/** Reveal spreads until someone has a turn (or the draft is done). */
function openUntilTurn(r: RoomState, ctx: RoomCtx) {
  let e = r.engine!;
  let guard = 0;
  while (!e.done && !e.currentPacks.length && guard++ < 60) {
    e = openSpread(e, ctx.data!.pool, spreadRng(r, e, ctx));
  }
  r.engine = e;
}

function afterDraftStep(r: RoomState, ctx: RoomCtx) {
  if (r.engine!.done) assemble(r, ctx);
  else armTurn(r, ctx);
}

function armTurn(r: RoomState, ctx: RoomCtx) {
  const e = r.engine;
  const secs = r.config.timerSecs;
  r.turnDeadline =
    r.phase === "drafting" && e && e.turnSeat != null && secs != null
      ? ctx.now + secs * 1000
      : null;
}

function assemble(r: RoomState, ctx: RoomCtx) {
  const e = r.engine!;
  const b = ctx.data!.bundle;
  const automaticStrengths = r.seats.map((_, i) =>
    computeStrength(boardRoster(e.boards[i]), e.boards[i].heroes, b.playerHeroStats, b.squadSynergy, null),
  );
  r.heroAssignments = automaticStrengths.map((strength, i) => {
    const assignment: Record<string, number> = {};
    boardRoster(e.boards[i]).forEach((player, playerIndex) => {
      const heroId = strength.assignment[playerIndex]?.heroId;
      if (heroId != null) assignment[String(player.steamId)] = heroId;
    });
    return assignment;
  });
  r.fieldSeed = Math.floor(ctx.random() * 1e9);
  recomputeAssembled(r, ctx);
  r.simSeed = Math.floor(ctx.random() * 1e9);
  r.phase = "assembled";
  r.turnDeadline = null;
}

/** Recalculate strengths and the seeded field after a manual hero swap. */
function recomputeAssembled(r: RoomState, ctx: RoomCtx) {
  const e = r.engine!;
  const b = ctx.data!.bundle;
  const strengths = r.seats.map((_, i) =>
    computeStrength(
      boardRoster(e.boards[i]),
      e.boards[i].heroes,
      b.playerHeroStats,
      b.squadSynergy,
      r.config.heroAlloc === "manual" ? (r.heroAssignments?.[i] ?? null) : null,
    ),
  );
  r.strengths = strengths;
  r.field = generateFieldMulti(
    r.seats.map((s, i) => ({
      ownerId: s.playerId,
      name: s.name,
      strength: strengths[i].overall,
      luck: luckTraitFor(boardRoster(e.boards[i])),
    })),
    r.fieldSeed!,
  );
}

// ---- snapshots ----

/**
 * The victory phrase for the current beat, if it is a taunt beat for a
 * human-vs-human series whose winner wrote phrases. This is the only place
 * a phrase ever leaves the server — and only one, at its moment.
 */
export function currentTaunt(
  r: RoomState,
  sim: SimProvider,
): { ownerId: string; phrase: string } | null {
  if (r.phase !== "broadcasting" || !r.beat || r.field == null || r.simSeed == null) return null;
  const { beats, result } = sim();
  const b = beats[Math.min(r.beat.idx, beats.length - 1)];
  if (b.kind !== "taunt") return null;
  const m = result.rounds[b.roundIdx]?.matches[b.matchIdx];
  if (!m) return null;
  const ownerId = tauntOwner(m);
  if (ownerId == null) return null;
  const phrases = r.phrases[ownerId];
  if (!phrases?.length) return null;
  return { ownerId, phrase: pickTaunt(r.simSeed, b.roundIdx, b.matchIdx, phrases) };
}

/** The full public snapshot — one type serves every seat and spectator. */
export function snapshotOf(r: RoomState, sim: SimProvider): RoomSnapshot {
  const e = r.engine;
  return {
    phase: r.phase,
    config: r.config,
    seats: r.seats,
    draft: e
      ? {
          packSeq: e.packSeq,
          roundSeq: e.roundSeq,
          openerSeat: e.openerSeat,
          turnSeat: e.turnSeat,
          turnDeadline: r.turnDeadline,
          currentPacks: e.currentPacks,
          boards: e.boards,
          takenSteamIds: e.takenSteamIds,
          deniedShelf: e.deniedShelf,
          mulligansLeft: e.mulligansLeft,
          deniesLeft: e.deniesLeft,
        }
      : null,
    strengths: r.strengths,
    heroAssignments: r.heroAssignments,
    field: r.field,
    simSeed: r.simSeed,
    // count: the client rebuilds the beat list locally and asserts agreement.
    beat: r.beat ? { ...r.beat, count: sim().beats.length } : null,
    taunt: currentTaunt(r, sim),
  };
}

// ---- persistence ----

/** Rooms persisted before the spread refactor stored a single `currentPack`;
 *  rooms persisted before the reducer had no beatDeadline / draftSeed. */
export function migrateRoom(stored: RoomState, now: number): RoomState {
  const e = stored.engine as (EngineState & { currentPack?: unknown }) | null;
  if (e && !Array.isArray(e.currentPacks)) {
    e.currentPacks = e.currentPack ? [e.currentPack as EngineState["currentPacks"][number]] : [];
    delete e.currentPack;
    e.roundSeq ??= e.packSeq;
  }
  stored.config = sanitizeConfig(stored.config);
  stored.heroAssignments ??= null;
  stored.phrases ??= {};
  stored.draftSeed ??= null;
  stored.beatDeadline ??= null;
  // A pre-reducer room caught mid-reveal has no stored deadline — tick soon
  // rather than stalling the broadcast for everyone.
  if (stored.phase === "broadcasting" && stored.beat?.playing && stored.beatDeadline == null) {
    stored.beatDeadline = now + 1500;
  }
  return stored;
}

export function sanitizeConfig(c: MpConfig): MpConfig {
  return {
    format: c.format === "standard" ? "standard" : "valve_legacy",
    cardMode: c.cardMode === "peak" || c.cardMode === "event" ? c.cardMode : "career",
    heroAlloc: c.heroAlloc === "manual" ? "manual" : "auto",
    timerSecs: c.timerSecs === 7 || c.timerSecs === 25 || c.timerSecs === null ? c.timerSecs : 15,
    mulligans: c.mulligans === 0 || c.mulligans === 2 ? c.mulligans : 1,
    // Rooms that predate the directory have no visibility at all — falling to
    // "private" keeps them exactly as discoverable as they were before.
    visibility:
      c.visibility === "public" || c.visibility === "spectatable" ? c.visibility : "private",
  };
}
