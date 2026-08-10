import {
  routePartykitRequest,
  Server,
  type Connection,
  type ConnectionContext,
} from "partyserver";
import { buildBeats, type Beat } from "../src/game/beats";
import { fetchBundle } from "../src/game/bundle";
import { buildCardPool } from "../src/game/cards";
import { simulateTournament } from "../src/game/sim";
import type { DataBundle, Pack, SimResult } from "../src/game/types";
import { listingKey, TOUCH_MS, type DirectoryEntry } from "../src/mp/directory";
import {
  DEFAULT_NAME,
  MAX_SEATS,
  sanitizeName,
  type ClientMsg,
  type ServerMsg,
} from "../src/mp/protocol";
import {
  freshRoom,
  migrateRoom,
  needsData,
  nextAlarm,
  roomReducer,
  snapshotOf,
  type RoomEvent,
  type RoomState,
} from "../src/mp/room";
import { CoperoDirectory } from "./directory";
import { DIRECTORY_ID, PROBE_HEADER, PROBE_PATH, PROBE_TOKEN } from "./probe";

interface Env {
  CoperoRoom: DurableObjectNamespace;
  CoperoDirectory: DurableObjectNamespace<CoperoDirectory>;
  ASSETS: Fetcher;
}

// ---------------------------------------------------------------------------
// One CoperoRoom = one lobby = one Durable Object. Server-authoritative:
// clients send intents, the room validates them against the pure state
// machine in src/mp/room.ts and broadcasts a full snapshot on every change.
//
// This class is the partyserver adapter at the Room seam: it owns sockets,
// storage, the data bundle, the directory, and the one alarm slot — and
// nothing else. Every rule lives in the reducer, where vitest can reach it.
//
// Hibernation-safe: the authoritative state lives in ctx.storage and is
// rehydrated in onStart; the card pool and sim are recomputed on demand
// (both are deterministic from stored config/seeds).
// ---------------------------------------------------------------------------

type ConnState = { playerId: string; name: string; spectating: boolean } | null;

export class CoperoRoom extends Server<Env> {
  static options = { hibernate: true };

  room: RoomState = freshRoom();
  private bundle: DataBundle | null = null;
  private pool: Pack[] | null = null;
  private sim: { beats: Beat[]; result: SimResult; forSeed: number | null } | null = null;
  /** Last listing published, so an unchanged room costs nothing. In-memory on
   *  purpose: a hibernation wake clears it and the next event re-announces. */
  private lastListing: string | null = null;
  private lastListingAt = 0;

  async onStart() {
    const stored = await this.ctx.storage.get<RoomState>("room");
    if (stored) this.room = migrateRoom(stored, Date.now());
  }

  // ---- the seam: every event goes through the reducer, effects run here ----

  private async dispatch(event: RoomEvent, conn?: Connection) {
    if (needsData(this.room, event)) await this.ensureData();
    const now = Date.now();
    const res = roomReducer(this.room, event, {
      now,
      random: Math.random,
      data: this.pool && this.bundle ? { pool: this.pool, bundle: this.bundle } : null,
      sim: () => this.ensureSim(),
      connectedIds: () => this.connectedIds(),
    });
    this.room = res.state;

    if (res.conns?.length || res.notify?.length) {
      const apply = (c: Connection) => {
        const st = c.state as ConnState;
        if (!st?.playerId) return;
        const patch = res.conns?.find((u) => u.playerId === st.playerId);
        if (patch) c.setState({ ...st, ...patch });
        const note = res.notify?.find((n) => n.playerId === st.playerId);
        if (note) this.sendError(c, note.code, note.msg);
      };
      if (conn) apply(conn);
      for (const c of this.getConnections()) if (c !== conn) apply(c);
    }
    if (res.reply && conn) this.sendError(conn, res.reply.code, res.reply.msg);

    if (res.purge) {
      await this.ctx.storage.deleteAll();
      // deleteAll wipes storage but not this object — without the reset, a
      // directory probe arriving before eviction would describe a dead room.
      this.room = freshRoom();
      this.publishDirectory();
      return;
    }

    if (res.changed) {
      await this.ctx.storage.put("room", this.room);
      this.broadcastSnapshot();
      this.publishDirectory();
    } else if (event.type === "close") {
      // A spectator leaving changes the watcher count even when no seat flag
      // moved, and the last person out must take the listing down.
      this.publishDirectory();
    }

    // Reconcile the one alarm slot to what the state says it should be.
    const want = nextAlarm(this.room, { now, empty: this.connectedIds().size === 0 });
    if (want == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(want);
  }

  private broadcastSnapshot() {
    const snapshot = snapshotOf(this.room, () => this.ensureSim());
    this.broadcast(JSON.stringify({ t: "snapshot", room: snapshot } satisfies ServerMsg));
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

  /** The sim + beat schedule, memoized per simSeed (assemble rolls a new one). */
  private ensureSim(): { beats: Beat[]; result: SimResult } {
    if (!this.sim || this.sim.forSeed !== this.room.simSeed) {
      const result = simulateTournament(this.room.field!, this.room.simSeed!);
      this.sim = { beats: buildBeats(result), result, forSeed: this.room.simSeed };
    }
    return this.sim;
  }

  // ---- connections ----

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const url = new URL(ctx.request.url);
    const playerId = url.searchParams.get("playerId") ?? "";
    const name = sanitizeName(url.searchParams.get("name") ?? "") || DEFAULT_NAME;
    const prefersSpectator = url.searchParams.get("spectator") === "1";
    if (!playerId) {
      this.sendError(conn, "no-player-id", "Missing playerId.");
      conn.close(4000, "no playerId");
      return;
    }
    // Connections begin as viewers; the reducer decides seat vs spectator.
    conn.setState({ playerId, name, spectating: true });
    await this.dispatch({ type: "connect", playerId, name, prefersSpectator }, conn);
  }

  async onClose() {
    await this.dispatch({ type: "close" });
  }

  async onError(conn: Connection, _err: Error) {
    await this.onClose();
    void conn;
  }

  // ---- directory ----

  /**
   * This room's public listing, or null if it must not be advertised.
   *
   * Every rule about who can find a room lives here and nowhere else, so a
   * listing that exists is a listing that is safe to show to anyone — the
   * directory can never leak a private room's code.
   */
  private listingFor(): DirectoryEntry | null {
    const r = this.room;
    const visibility = r.config.visibility;
    if (visibility === "private") return null;
    if (r.phase === "done") return null;
    // Spectatable rooms stay hidden until there is something to spectate.
    if (visibility === "spectatable" && r.phase === "lobby") return null;

    const seated = new Set(r.seats.map((s) => s.playerId));
    const here = new Set<string>();
    let watchers = 0;
    for (const c of this.getConnections()) {
      const st = c.state as ConnState;
      if (!st?.playerId || here.has(st.playerId)) continue;
      here.add(st.playerId);
      if (!seated.has(st.playerId)) watchers++;
    }
    // Nobody home, nothing to advertise — in any phase. This one rule is what
    // keeps abandoned rooms off the lists without a reaper chasing them.
    if (here.size === 0) return null;

    return {
      code: this.name,
      visibility,
      phase: r.phase,
      seats: r.seats.length,
      maxSeats: MAX_SEATS,
      host: r.seats.find((s) => s.isHost)?.name ?? "",
      teams: r.seats.map((s) => s.name),
      watchers,
      rev: Date.now(),
    };
  }

  /**
   * Announce (or retract) this room. Deliberately not awaited: the directory
   * is one object in one colo, a draft action must never wait on it, and a
   * throw here would trip onMessage's catch-all and roll the room back.
   */
  private publishDirectory() {
    let entry: DirectoryEntry | null = null;
    try {
      entry = this.listingFor();
    } catch (e) {
      console.error("directory: could not build listing:", e);
      return;
    }
    const key = listingKey(entry);
    const now = Date.now();
    // Nothing visible changed, and the entry is not close to going stale.
    if (key === this.lastListing && (entry === null || now - this.lastListingAt < TOUCH_MS)) return;
    this.lastListing = key;
    this.lastListingAt = now;

    const ns = this.env.CoperoDirectory;
    const stub = ns.get(ns.idFromName(DIRECTORY_ID));
    this.ctx.waitUntil(
      stub.publish(this.name, entry).catch((e: unknown) => {
        console.error("directory: publish failed:", e);
        this.lastListing = null; // retry on the next change
      }),
    );
  }

  /**
   * The directory's liveness probe. Server.fetch() runs onStart before this,
   * so the room is hydrated even on a cold wake — which is exactly why the
   * probe comes in over fetch and not as an RPC method (RPC skips init).
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== PROBE_PATH || request.headers.get(PROBE_HEADER) !== PROBE_TOKEN) {
      return new Response("Not found", { status: 404 });
    }
    const entry = this.listingFor();
    // The reply is itself a publish — the directory re-stamps from it.
    this.lastListing = listingKey(entry);
    this.lastListingAt = Date.now();
    return Response.json({ entry });
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>();
    for (const c of this.getConnections()) {
      const st = c.state as ConnState;
      if (st?.playerId) ids.add(st.playerId);
    }
    return ids;
  }

  // ---- messages ----

  async onMessage(conn: Connection, raw: string | ArrayBuffer) {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw));
    } catch {
      return this.sendError(conn, "bad-json", "Could not parse message.");
    }
    const st = conn.state as ConnState;
    if (!st?.playerId) return this.sendError(conn, "no-player-id", "Missing playerId.");
    try {
      await this.dispatch({ type: "message", playerId: st.playerId, connName: st.name, msg }, conn);
    } catch (e) {
      // The reducer works on a clone, so in-memory state is still the last
      // accepted one — but re-anchor to storage anyway and tell everyone.
      console.error("room error, restoring from storage:", e);
      const stored = await this.ctx.storage.get<RoomState>("room");
      if (stored) this.room = migrateRoom(stored, Date.now());
      this.sendError(conn, "internal", "Something went wrong — room state restored, try again.");
      this.broadcastSnapshot();
    }
  }

  // ---- the one alarm: turn timeout / beat ticker / cleanup ----

  async onAlarm() {
    await this.dispatch({ type: "alarm" });
  }
}

export { CoperoDirectory };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/rooms") {
      const ns = env.CoperoDirectory;
      const data = await ns.get(ns.idFromName(DIRECTORY_ID)).list();
      return Response.json(data, { headers: { "cache-control": "no-store" } });
    }

    // routePartykitRequest routes EVERY Durable Object binding by kebab-cased
    // name, so the directory and the rooms' internal probe endpoint would both
    // be reachable from the internet. Rooms take websockets and nothing else;
    // the directory takes nothing at all.
    if (url.pathname.startsWith("/parties/")) {
      const isWebSocket = request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      if (!isWebSocket || url.pathname.startsWith("/parties/copero-directory/")) {
        return new Response("Not found", { status: 404 });
      }
    }

    return (
      (await routePartykitRequest(request, env as unknown as Record<string, unknown>)) ??
      env.ASSETS.fetch(request)
    );
  },
} satisfies ExportedHandler<Env>;
