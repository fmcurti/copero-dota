import {
  routePartykitRequest,
  Server,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import { buildBeats, type Beat } from "../src/game/beats";
import { fetchBundle } from "../src/game/bundle";
import { buildCardPool } from "../src/game/cards";
import { generateFieldMulti } from "../src/game/field";
import { randomSeed } from "../src/game/rng";
import { simulateTournament } from "../src/game/sim";
import { computeStrength, swapHeroAssignment } from "../src/game/strength";
import type { DataBundle, Pack, SimTeam, TeamStrength } from "../src/game/types";
import { autopick } from "../src/mp/autopick";
import {
  applyAction,
  boardRoster,
  createDraft,
  openSpread,
  type EngineState,
} from "../src/mp/engine";
import {
  DEFAULT_MP_CONFIG,
  MAX_SEATS,
  MIN_SEATS,
  type ClientMsg,
  type MpConfig,
  type Phase,
  type RoomSnapshot,
  type Seat,
  type ServerMsg,
} from "../src/mp/protocol";
import { seatPlayer, unseatPlayer } from "../src/mp/seating";

interface Env {
  CoperoRoom: DurableObjectNamespace;
  ASSETS: Fetcher;
}

// ---------------------------------------------------------------------------
// One CoperoRoom = one lobby = one Durable Object. Server-authoritative:
// clients send intents, the room validates them against the pure engine and
// broadcasts a full snapshot on every change (room state is tiny).
//
// Hibernation-safe: the authoritative state lives in ctx.storage and is
// rehydrated in onStart; the card pool and sim are recomputed on demand
// (both are deterministic from stored config/seeds). The single DO alarm is
// time-shared: turn timer while drafting, beat ticker while broadcasting,
// self-cleanup once done and empty.
// ---------------------------------------------------------------------------

interface RoomState {
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
}

const freshRoom = (): RoomState => ({
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
});

const CLEANUP_MS = 60 * 60 * 1000;

type ConnState = { playerId: string; name: string; spectating: boolean } | null;

export class CoperoRoom extends Server<Env> {
  static options = { hibernate: true };

  room: RoomState = freshRoom();
  private bundle: DataBundle | null = null;
  private pool: Pack[] | null = null;
  private beats: Beat[] | null = null;

  async onStart() {
    const stored = await this.ctx.storage.get<RoomState>("room");
    if (stored) this.room = migrateRoom(stored);
  }

  private async save() {
    await this.ctx.storage.put("room", this.room);
  }

  private snapshot(): RoomSnapshot {
    const r = this.room;
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
      beat: r.beat,
    };
  }

  private broadcastSnapshot() {
    this.broadcast(JSON.stringify({ t: "snapshot", room: this.snapshot() } satisfies ServerMsg));
  }

  private sendError(conn: Connection, code: string, msg: string) {
    conn.send(JSON.stringify({ t: "error", code, msg } satisfies ServerMsg));
  }

  /** Load the data bundle + card pool (config is frozen once the draft starts). */
  private async ensureData() {
    if (this.pool && this.bundle) return;
    this.bundle = await fetchBundle(async (name) => {
      // Host is ignored by the deployed assets binding; "localhost" also passes
      // the Vite dev server's host check when the plugin proxies this in dev.
      const res = await this.env.ASSETS.fetch(`http://localhost/data/${name}`);
      const ct = res.headers.get("content-type") ?? "";
      // SPA not_found_handling turns typos into index.html with a 200 — catch that.
      if (!res.ok || !ct.includes("json")) throw new Error(`data ${name}: ${res.status} ${ct}`);
      return res.json();
    });
    this.pool = buildCardPool(this.bundle, this.room.config.format, this.room.config.cardMode)
      .packs;
  }

  private ensureBeats(): Beat[] {
    if (!this.beats) {
      const result = simulateTournament(this.room.field!, this.room.simSeed!);
      this.beats = buildBeats(result);
    }
    return this.beats;
  }

  // ---- connections ----

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get("playerId") ?? "";
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 30) || "Sin Nombre";
    const prefersSpectator = url.searchParams.get("spectator") === "1";
    if (!playerId) {
      this.sendError(conn, "no-player-id", "Missing playerId.");
      conn.close(4000, "no playerId");
      return;
    }
    // Connections begin as viewers and are promoted only when they own/claim a seat.
    conn.setState({ playerId, name, spectating: true });
    const seatIdx = this.room.seats.findIndex((s) => s.playerId === playerId);
    if (seatIdx >= 0 && prefersSpectator && this.room.phase === "lobby") {
      conn.setState({ playerId, name: this.room.seats[seatIdx].name, spectating: true });
      this.room.seats = unseatPlayer(this.room.seats, playerId);
    } else if (seatIdx >= 0) {
      // Reattach only — never clobber the seat name (it may have been renamed
      // in the lobby, and reconnects replay the stale query-string name).
      const savedName = this.room.seats[seatIdx].name;
      this.room.seats = seatPlayer(this.room.seats, playerId, name);
      conn.setState({ playerId, name: savedName, spectating: false });
    } else if (!prefersSpectator && this.room.phase === "lobby") {
      const nextSeats = seatPlayer(this.room.seats, playerId, name);
      const seated = nextSeats.length > this.room.seats.length;
      this.room.seats = nextSeats;
      conn.setState({ playerId, name, spectating: !seated });
    }
    await this.save();
    this.broadcastSnapshot();
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.getConnections()) {
      const st = c.state as ConnState;
      if (st?.playerId) ids.add(st.playerId);
    }
    return ids;
  }

  async onClose() {
    const ids = this.connectedIds();
    let changed = false;
    for (const s of this.room.seats) {
      const now = ids.has(s.playerId);
      if (s.connected !== now) {
        s.connected = now;
        changed = true;
      }
    }
    if (changed) {
      await this.save();
      this.broadcastSnapshot();
    }
    if (this.room.phase === "done" && ids.size === 0) {
      await this.ctx.storage.setAlarm(Date.now() + CLEANUP_MS);
    }
  }

  async onError(conn: Connection, _err: Error) {
    await this.onClose();
    void conn;
  }

  // ---- messages ----

  async onMessage(conn: Connection, raw: string | ArrayBuffer) {
    try {
      await this.handleMessage(conn, raw);
    } catch (e) {
      // Never leave the room with half-applied in-memory state: fall back to
      // the last persisted snapshot and tell everyone where we are.
      console.error("room error, restoring from storage:", e);
      const stored = await this.ctx.storage.get<RoomState>("room");
      if (stored) this.room = stored;
      this.sendError(conn, "internal", "Something went wrong — room state restored, try again.");
      this.broadcastSnapshot();
    }
  }

  private async handleMessage(conn: Connection, raw: string | ArrayBuffer) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.sendError(conn, "bad-json", "Could not parse message.");
    }
    const playerId = (conn.state as ConnState)?.playerId;
    const connection = conn.state as ConnState;
    if (!playerId || !connection)
      return this.sendError(conn, "no-player-id", "Missing playerId.");

    if (msg.t === "spectate") {
      if (this.room.phase !== "lobby")
        return this.sendError(conn, "bad-phase", "Seats are locked after the draft starts.");
      this.room.seats = unseatPlayer(this.room.seats, playerId);
      conn.setState({ ...connection, spectating: true });
      await this.save();
      this.broadcastSnapshot();
      return;
    }

    if (msg.t === "takeSeat") {
      if (this.room.phase !== "lobby")
        return this.sendError(conn, "bad-phase", "Seats are locked after the draft starts.");
      const alreadySeated = this.room.seats.some((seat) => seat.playerId === playerId);
      if (!alreadySeated && this.room.seats.length >= MAX_SEATS)
        return this.sendError(conn, "room-full", "Room is full.");
      this.room.seats = seatPlayer(this.room.seats, playerId, connection.name);
      conn.setState({ ...connection, spectating: false });
      await this.save();
      this.broadcastSnapshot();
      return;
    }

    const seat = this.room.seats.findIndex((s) => s.playerId === playerId);
    if (seat < 0) return this.sendError(conn, "no-seat", "You are not seated in this room.");
    const isHost = this.room.seats[seat].isHost;

    switch (msg.t) {
      case "configure": {
        if (!isHost) return this.sendError(conn, "not-host", "Only the host can configure.");
        if (this.room.phase !== "lobby")
          return this.sendError(conn, "bad-phase", "Config is locked after start.");
        this.room.config = sanitizeConfig({ ...this.room.config, ...msg.config });
        break;
      }
      case "rename": {
        if (this.room.phase !== "lobby")
          return this.sendError(conn, "bad-phase", "Names are locked after start.");
        const name = (msg.name ?? "").trim().slice(0, 30);
        if (!name) return this.sendError(conn, "bad-name", "Name cannot be empty.");
        this.room.seats[seat].name = name;
        conn.setState({ ...connection, name });
        break;
      }
      case "start": {
        if (!isHost) return this.sendError(conn, "not-host", "Only the host can start.");
        if (this.room.phase !== "lobby")
          return this.sendError(conn, "bad-phase", "Already started.");
        if (this.room.seats.length < MIN_SEATS)
          return this.sendError(conn, "need-players", `Need at least ${MIN_SEATS} drafters.`);
        await this.ensureData();
        this.room.engine = createDraft(this.room.seats.length, {
          mulligans: this.room.config.mulligans,
        });
        this.room.phase = "drafting";
        this.openUntilTurn();
        await this.afterDraftStep();
        return;
      }
      case "pick":
      case "deny":
      case "pass":
      case "mulligan": {
        if (this.room.phase !== "drafting" || !this.room.engine)
          return this.sendError(conn, "bad-phase", "No draft in progress.");
        // After a hibernation wake the pool is gone from memory; reload it
        // BEFORE applying the action — finishing a pack needs it to open the next.
        await this.ensureData();
        const action =
          msg.t === "pick"
            ? ({ type: "pick", card: msg.card } as const)
            : msg.t === "deny"
              ? ({ type: "deny", card: msg.card } as const)
              : msg.t === "pass"
                ? ({ type: "pass" } as const)
                : ({ type: "mulligan" } as const);
        const r = applyAction(this.room.engine, seat, action);
        if (r.error) return this.sendError(conn, r.error, `Illegal action (${r.error}).`);
        this.room.engine = r.state;
        this.openUntilTurn();
        await this.afterDraftStep();
        return;
      }
      case "assignHero": {
        if (this.room.phase !== "assembled" || !this.room.engine)
          return this.sendError(conn, "bad-phase", "Hero assignments are already locked.");
        if (this.room.config.heroAlloc !== "manual")
          return this.sendError(conn, "auto-assignment", "This room uses automatic hero assignment.");

        const board = this.room.engine.boards[seat];
        const roster = boardRoster(board);
        if (!roster.some((p) => p.steamId === msg.steamId))
          return this.sendError(conn, "bad-player", "That player is not on your roster.");
        if (!board.heroes.includes(msg.heroId))
          return this.sendError(conn, "bad-hero", "That hero is not on your roster.");

        const assignments = this.room.heroAssignments;
        if (!assignments?.[seat])
          return this.sendError(conn, "no-assignment", "Hero assignments are unavailable.");
        assignments[seat] = swapHeroAssignment(
          assignments[seat],
          String(msg.steamId),
          msg.heroId,
        );
        await this.recomputeAssembled();
        break;
      }
      case "play": {
        if (!isHost) return this.sendError(conn, "not-host", "Only the host can play.");
        if (this.room.phase !== "assembled")
          return this.sendError(conn, "bad-phase", "Not ready to play.");
        this.room.phase = "broadcasting";
        this.room.beat = { idx: 0, playing: true };
        const beats = this.ensureBeats();
        await this.ctx.storage.setAlarm(Date.now() + beats[0].ms);
        break;
      }
      case "beat": {
        if (!isHost) return this.sendError(conn, "not-host", "Only the host controls the reveal.");
        if (this.room.phase !== "broadcasting" || !this.room.beat)
          return this.sendError(conn, "bad-phase", "No broadcast running.");
        const beats = this.ensureBeats();
        if (msg.action === "pause") {
          this.room.beat.playing = false;
          await this.ctx.storage.deleteAlarm();
        } else if (msg.action === "resume") {
          this.room.beat.playing = true;
          await this.ctx.storage.setAlarm(Date.now() + beats[this.room.beat.idx].ms);
        } else {
          this.room.beat = { idx: beats.length - 1, playing: false };
          this.room.phase = "done";
          await this.ctx.storage.deleteAlarm();
        }
        break;
      }
      default:
        return this.sendError(conn, "unknown", "Unknown message.");
    }
    await this.save();
    this.broadcastSnapshot();
  }

  // ---- draft plumbing ----

  /** Reveal spreads until someone has a turn (or the draft is done). */
  private openUntilTurn() {
    let e = this.room.engine!;
    let guard = 0;
    while (!e.done && !e.currentPacks.length && guard++ < 60) {
      e = openSpread(e, this.pool!, Math.random);
    }
    this.room.engine = e;
  }

  private async afterDraftStep() {
    const e = this.room.engine!;
    if (e.done) {
      await this.assemble();
    } else {
      await this.armTurnAlarm();
    }
    await this.save();
    this.broadcastSnapshot();
  }

  private async armTurnAlarm() {
    const e = this.room.engine;
    const secs = this.room.config.timerSecs;
    if (this.room.phase !== "drafting" || !e || e.turnSeat == null || secs == null) {
      this.room.turnDeadline = null;
      await this.ctx.storage.deleteAlarm();
      return;
    }
    this.room.turnDeadline = Date.now() + secs * 1000;
    await this.ctx.storage.setAlarm(this.room.turnDeadline);
  }

  private async assemble() {
    await this.ensureData();
    const e = this.room.engine!;
    const b = this.bundle!;
    const automaticStrengths = this.room.seats.map((_, i) =>
      computeStrength(boardRoster(e.boards[i]), e.boards[i].heroes, b.playerHeroStats, b.squadSynergy, null),
    );
    this.room.heroAssignments = automaticStrengths.map((strength, i) => {
      const assignment: Record<string, number> = {};
      boardRoster(e.boards[i]).forEach((player, playerIndex) => {
        const heroId = strength.assignment[playerIndex]?.heroId;
        if (heroId != null) assignment[String(player.steamId)] = heroId;
      });
      return assignment;
    });
    this.room.fieldSeed = randomSeed();
    await this.recomputeAssembled();
    this.room.simSeed = randomSeed();
    this.beats = null;
    this.room.phase = "assembled";
    this.room.turnDeadline = null;
    await this.ctx.storage.deleteAlarm();
  }

  /** Recalculate strengths and the seeded field after a manual hero swap. */
  private async recomputeAssembled() {
    await this.ensureData();
    const e = this.room.engine!;
    const b = this.bundle!;
    const strengths = this.room.seats.map((_, i) =>
      computeStrength(
        boardRoster(e.boards[i]),
        e.boards[i].heroes,
        b.playerHeroStats,
        b.squadSynergy,
        this.room.config.heroAlloc === "manual" ? (this.room.heroAssignments?.[i] ?? null) : null,
      ),
    );
    this.room.strengths = strengths;
    this.room.field = generateFieldMulti(
      this.room.seats.map((s, i) => ({
        ownerId: s.playerId,
        name: s.name,
        strength: strengths[i].overall,
      })),
      this.room.fieldSeed!,
    );
  }

  // ---- the one alarm: turn timeout / beat ticker / cleanup ----

  async onAlarm() {
    const r = this.room;
    if (r.phase === "drafting" && r.engine && r.engine.turnSeat != null) {
      if (r.turnDeadline == null || Date.now() < r.turnDeadline - 500) return; // stale
      await this.ensureData();
      const seat = r.engine.turnSeat;
      const action = autopick(r.engine, seat, this.bundle!.playerHeroStats);
      const res = applyAction(r.engine, seat, action);
      if (!res.error) this.room.engine = res.state;
      this.openUntilTurn();
      await this.afterDraftStep();
      return;
    }
    if (r.phase === "broadcasting" && r.beat) {
      const beats = this.ensureBeats();
      if (!r.beat.playing) return;
      const idx = Math.min(r.beat.idx + 1, beats.length - 1);
      r.beat = { idx, playing: idx < beats.length - 1 };
      if (idx >= beats.length - 1) {
        r.phase = "done";
      } else {
        await this.ctx.storage.setAlarm(Date.now() + beats[idx].ms);
      }
      await this.save();
      this.broadcastSnapshot();
      return;
    }
    if (r.phase === "done" && this.connectedIds().size === 0) {
      await this.ctx.storage.deleteAll();
    }
  }
}

/** Rooms persisted before the spread refactor stored a single `currentPack`. */
function migrateRoom(stored: RoomState): RoomState {
  const e = stored.engine as (EngineState & { currentPack?: unknown }) | null;
  if (e && !Array.isArray(e.currentPacks)) {
    e.currentPacks = e.currentPack ? [e.currentPack as EngineState["currentPacks"][number]] : [];
    delete e.currentPack;
    e.roundSeq ??= e.packSeq;
  }
  stored.config = sanitizeConfig(stored.config);
  stored.heroAssignments ??= null;
  return stored;
}

function sanitizeConfig(c: MpConfig): MpConfig {
  return {
    format: c.format === "standard" ? "standard" : "valve_legacy",
    cardMode: c.cardMode === "peak" || c.cardMode === "event" ? c.cardMode : "career",
    heroAlloc: c.heroAlloc === "manual" ? "manual" : "auto",
    timerSecs: c.timerSecs === 7 || c.timerSecs === 25 || c.timerSecs === null ? c.timerSecs : 15,
    mulligans: c.mulligans === 0 || c.mulligans === 2 ? c.mulligans : 1,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ??
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
