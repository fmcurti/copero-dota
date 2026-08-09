import { DurableObject } from "cloudflare:workers";
import {
  DIRECTORY_TICK_MS,
  isFresh,
  overflowCodes,
  probeCodes,
  staleCodes,
  type DirectoryEntry,
  type RoomListing,
} from "../src/mp/directory";
import { PROBE_HEADER, PROBE_TOKEN, PROBE_URL, type ProbeEnv } from "./probe";

// ---------------------------------------------------------------------------
// The only thing in the system that knows a room exists. Rooms publish into it
// as they change; GET /api/rooms reads it back.
//
// Authoritative for nothing. If it is wrong the worst case is a lobby that
// shows up late or a ghost row that rots out within LISTING_TTL_MS — it is
// never on a draft's critical path, and rooms never read from it.
// ---------------------------------------------------------------------------

const key = (code: string) => `room:${code}`;

export class CoperoDirectory extends DurableObject<ProbeEnv> {
  /** Write-through cache; null after eviction, refilled from storage. */
  private cache: Map<string, RoomListing> | null = null;

  private async entries(): Promise<Map<string, RoomListing>> {
    if (!this.cache) {
      const rows = await this.ctx.storage.list<RoomListing>({ prefix: "room:" });
      this.cache = new Map([...rows.values()].map((l) => [l.code, l]));
    }
    return this.cache;
  }

  private async drop(code: string, all: Map<string, RoomListing>) {
    all.delete(code);
    await this.ctx.storage.delete(key(code));
  }

  private async upsert(entry: DirectoryEntry, all: Map<string, RoomListing>) {
    const next: RoomListing = { ...entry, updatedAt: Date.now() };
    all.set(next.code, next);
    await this.ctx.storage.put(key(next.code), next);
  }

  /** A room announces itself, or retracts with null. */
  async publish(code: string, entry: DirectoryEntry | null): Promise<void> {
    const all = await this.entries();
    const prev = all.get(code);
    if (!entry) {
      if (prev) await this.drop(code, all);
      return;
    }
    // Publishes are fire-and-forget, so they can land out of order: without
    // this a stale "lobby" could overwrite "drafting" and a running game would
    // sit on the home page advertised as joinable.
    if (prev && prev.rev > entry.rev) return;
    await this.upsert({ ...entry, code }, all);
    for (const victim of overflowCodes([...all.values()])) await this.drop(victim, all);
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_TICK_MS);
    }
  }

  /** Everything the SPA needs. Bucketing happens client-side, from src/mp/directory. */
  async list(): Promise<{ now: number; rooms: RoomListing[] }> {
    const now = Date.now();
    const all = await this.entries();
    return { now, rooms: [...all.values()].filter((l) => isFresh(l, now)) };
  }

  /**
   * Reconciliation. Rooms hibernate silently — an idle lobby emits nothing for
   * minutes — and their single alarm slot is already taken by the turn timer,
   * the beat ticker and self-cleanup, so they cannot heartbeat. This is the
   * only place that can tell "hibernating and alive" from "gone".
   */
  async alarm(): Promise<void> {
    const all = await this.entries();
    const now = Date.now();
    for (const code of staleCodes([...all.values()], now)) await this.drop(code, all);
    await Promise.all(probeCodes([...all.values()], now).map((c) => this.probe(c, all)));
    if (all.size > 0) await this.ctx.storage.setAlarm(Date.now() + DIRECTORY_TICK_MS);
  }

  private async probe(code: string, all: Map<string, RoomListing>) {
    try {
      const ns = this.env.CoperoRoom;
      const res = await ns.get(ns.idFromName(code)).fetch(PROBE_URL, {
        headers: { [PROBE_HEADER]: PROBE_TOKEN },
      });
      const body = res.ok
        ? await res.json<{ entry: DirectoryEntry | null }>()
        : { entry: null };
      if (!body.entry) {
        await this.drop(code, all);
        return;
      }
      await this.upsert({ ...body.entry, code }, all);
    } catch (e) {
      // Leave the entry alone: a transient failure must never delete a live
      // game. If the room really is unreachable, the TTL sweep takes it.
      console.error(`directory: probe ${code} failed:`, e);
    }
  }
}
