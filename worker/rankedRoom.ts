import type { Connection, ConnectionContext } from "partyserver";
import type { RoomEvent } from "../src/mp/room";
import { RANKED_CONFIG, RANKED_SEASON } from "../src/ranked/protocol";
import { STARTING_RATING, rateMatch, type RatedPlayer } from "../src/ranked/rating";
import { CoperoRoom, type ConnState } from "./room";

// ---------------------------------------------------------------------------
// The ranked room adapter (docs/RANKED.md). Same reducer, same effects loop as
// CoperoRoom — the differences live exactly at the seams the base class
// exposes:
//
// - Identity: seats belong to Better Auth user ids. The Worker validates the
//   session at the WebSocket upgrade and forwards the verified identity in
//   internal headers; browser playerIds are only ever spectators here.
// - Birth: rooms are created by the queue through an internal init call that
//   seats the matched roster — never by a client flag.
// - Death: when the match reaches "done", this adapter computes the rating
//   exchange and writes the authoritative result to D1, exactly once.
// ---------------------------------------------------------------------------

/** Set by the Worker on ranked upgrades after session validation. Anything a
 *  client sent under these names was stripped at the edge. */
export const IDENTITY_ID_HEADER = "x-copero-user-id";
/** URI-encoded — account names are not header-safe by construction. */
export const IDENTITY_NAME_HEADER = "x-copero-user-name";

export const RANKED_INIT_PATH = "/__ranked/init";
export const RANKED_RELEASE_PATH = "/__ranked/release";
export const RANKED_INTERNAL_HEADER = "x-copero-ranked";
/** Like the probe token: a second lock behind the edge guard, not a secret. */
export const RANKED_INTERNAL_TOKEN = "copero-ranked-internal-4a8e";

export interface RankedRosterEntry {
  userId: string;
  name: string;
}

interface RankedProfileRow {
  userId: string;
  rating: number;
  gamesPlayed: number;
}

export class CoperoRankedRoom extends CoperoRoom {
  /** Fast path only — the durable guard is the storage flag + the match PK. */
  private rated = false;

  protected directoryKind(): "casual" | "ranked" {
    return "ranked";
  }

  // ---- identity: sessions decide seats, browsers only ever watch ----

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const userId = ctx.request.headers.get(IDENTITY_ID_HEADER);
    const seat = userId ? this.room.seats.find((s) => s.playerId === userId) : undefined;
    if (userId && seat) {
      // A roster member is always their seat — spectator preferences and
      // client-sent names are ignored (the seat name is the team name).
      conn.setState({ playerId: userId, name: seat.name, spectating: false } satisfies ConnState);
      await this.dispatch(
        { type: "connect", playerId: userId, name: seat.name, prefersSpectator: false },
        conn,
      );
      return;
    }
    // Everyone else watches. Signed-in visitors count by user id; anonymous
    // ones by their browser id, like any casual spectator.
    const url = new URL(ctx.request.url);
    const playerId = userId ?? url.searchParams.get("playerId") ?? crypto.randomUUID();
    conn.setState({ playerId, name: "Spectator", spectating: true } satisfies ConnState);
    await this.dispatch(
      { type: "connect", playerId, name: "Spectator", prefersSpectator: true },
      conn,
    );
  }

  // ---- birth: the queue's init call ----

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === RANKED_INIT_PATH) {
      if (
        request.method !== "POST" ||
        request.headers.get(RANKED_INTERNAL_HEADER) !== RANKED_INTERNAL_TOKEN
      ) {
        return new Response("Not found", { status: 404 });
      }
      const { roster } = await request.json<{ roster: RankedRosterEntry[] }>();
      this.rated = false;
      await this.ctx.storage.put("matchStartedAt", Date.now());
      await this.dispatch({
        type: "rankedInit",
        roster: roster.map((p) => ({ playerId: p.userId, name: p.name })),
        config: RANKED_CONFIG,
      });
      const ok = this.room.ranked != null && this.room.seats.length === roster.length;
      return ok
        ? Response.json({ ok: true })
        : Response.json({ ok: false }, { status: 409 });
    }
    return super.onRequest(request);
  }

  // ---- death: the authoritative result ----

  protected async dispatch(event: RoomEvent, conn?: Connection) {
    const before = this.room.phase;
    // Retry seam: any event on a finished room (including the cleanup alarm
    // about to purge it) gets another chance to land a failed rating write.
    if (before === "done") await this.tryRecordMatch();
    await super.dispatch(event, conn);
    if (before !== "done" && this.room.phase === "done") await this.tryRecordMatch();
  }

  /**
   * Compute and persist the match result, idempotently. The D1 batch is
   * atomic, and the plain INSERT on ranked_match's primary key makes a replay
   * a constraint error, not a double-count — the storage flag only saves work.
   */
  private async tryRecordMatch() {
    if (this.rated) return;
    try {
      if (await this.ctx.storage.get<boolean>("rated")) {
        this.rated = true;
        return;
      }
      const r = this.room;
      if (r.phase !== "done" || !r.ranked || r.field == null || r.simSeed == null) return;
      const { result } = this.ensureSim();

      const db = this.env.AUTH_DB;
      const ids = r.seats.map((s) => s.playerId);
      const marks = ids.map(() => "?").join(",");
      const stored = await db
        .prepare(
          `SELECT userId, rating, gamesPlayed FROM ranked_profile
           WHERE season = ? AND userId IN (${marks})`,
        )
        .bind(RANKED_SEASON, ...ids)
        .all<RankedProfileRow>();
      const profiles = new Map(stored.results.map((row) => [row.userId, row]));

      const players: RatedPlayer[] = r.seats.map((seat) => {
        const stats = result.ownerStats[seat.playerId];
        if (!stats) throw new Error(`no ownerStats for seat ${seat.playerId}`);
        const profile = profiles.get(seat.playerId);
        return {
          userId: seat.playerId,
          rating: profile?.rating ?? STARTING_RATING,
          gamesPlayed: profile?.gamesPlayed ?? 0,
          place: stats.place,
          gamesWon: stats.gamesWon,
        };
      });
      const changes = rateMatch(players);

      const now = Date.now();
      const startedAt = (await this.ctx.storage.get<number>("matchStartedAt")) ?? now;
      const statements = [
        db
          .prepare(
            `INSERT INTO ranked_match (id, season, config, simSeed, startedAt, completedAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .bind(this.name, RANKED_SEASON, JSON.stringify(r.config), r.simSeed, startedAt, now),
        ...r.seats.map((seat, seatIdx) => {
          const stats = result.ownerStats[seat.playerId]!;
          const change = changes.find((c) => c.userId === seat.playerId)!;
          return db
            .prepare(
              `INSERT INTO ranked_match_player
               (matchId, userId, seat, teamName, place, gamesWon,
                ratingBefore, ratingExchange, ratingBonus, ratingAfter)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              this.name,
              seat.playerId,
              seatIdx,
              seat.name,
              stats.place,
              stats.gamesWon,
              change.before,
              change.exchange,
              change.bonus,
              change.after,
            );
        }),
        ...changes.map((change) =>
          db
            .prepare(
              `INSERT INTO ranked_profile (userId, season, rating, gamesPlayed, createdAt, updatedAt)
               VALUES (?, ?, ?, 1, ?, ?)
               ON CONFLICT(userId, season) DO UPDATE SET
                 rating = excluded.rating,
                 gamesPlayed = ranked_profile.gamesPlayed + 1,
                 updatedAt = excluded.updatedAt`,
            )
            .bind(change.userId, RANKED_SEASON, change.after, now, now),
        ),
      ];

      try {
        await db.batch(statements);
      } catch (e) {
        // A primary-key conflict means an earlier attempt already landed the
        // whole batch (it is atomic) — everything else is a real failure.
        if (!/UNIQUE|PRIMARY KEY/i.test(String(e))) throw e;
      }
      await this.ctx.storage.put("rated", true);
      this.rated = true;
      this.releaseQueueHolds();
    } catch (e) {
      // Leave unrated: the next event on this room retries.
      console.error(`ranked: recording match ${this.name} failed:`, e);
    }
  }

  /** Tell the queue these players are free to queue again. Fire-and-forget:
   *  the queue's own TTL on active entries is the safety net. */
  private releaseQueueHolds() {
    const ns = this.env.CoperoRankedQueue;
    const stub = ns.get(ns.idFromName("main"));
    this.ctx.waitUntil(
      stub
        .fetch(`https://copero.internal${RANKED_RELEASE_PATH}`, {
          method: "POST",
          headers: {
            [RANKED_INTERNAL_HEADER]: RANKED_INTERNAL_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ code: this.name }),
        })
        .catch((e: unknown) => console.error("ranked: queue release failed:", e)),
    );
  }
}
