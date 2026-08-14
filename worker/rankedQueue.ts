import { Server, type Connection, type ConnectionContext } from "partyserver";
import { DEFAULT_NAME, sanitizeName } from "../src/mp/protocol";
import {
  formMatch,
  holdVerdict,
  queueMembers,
  queuePolicy,
  releasedHoldKeys,
  type ActiveHold,
  type QueueMember,
} from "../src/ranked/queue";
import {
  makeRankedCode,
  type QueueServerMsg,
  type RankedQueueStatus,
} from "../src/ranked/protocol";
import type { Env } from "./env";
import {
  IDENTITY_ID_HEADER,
  IDENTITY_NAME_HEADER,
  RANKED_INIT_URL,
  RANKED_INTERNAL_HEADER,
  RANKED_INTERNAL_TOKEN,
  RANKED_RELEASE_PATH,
  type RankedRosterEntry,
} from "./rankedRoom";

// ---------------------------------------------------------------------------
// The queue host: the one global ranked queue Durable Object (docs/RANKED.md).
// It owns sockets, storage, the alarm slot, and the room-init call — every
// matchmaking rule lives in the Queue policy (src/ranked/queue.ts), where
// vitest reaches it. Presence is membership: closing the page leaves the
// queue, and the policy derives members from live connections.
//
// The Worker validates the session at the upgrade; identity arrives in the
// same internal headers the ranked room trusts. No session, no socket.
// ---------------------------------------------------------------------------

type QueueConnState = QueueMember | null;

const holdKey = (userId: string) => `active:${userId}`;

export class CoperoRankedQueue extends Server<Env> {
  static options = { hibernate: true };

  async onConnect(conn: Connection, ctx: ConnectionContext) {
    const userId = ctx.request.headers.get(IDENTITY_ID_HEADER);
    const rawName = ctx.request.headers.get(IDENTITY_NAME_HEADER);
    if (!userId) {
      this.send(conn, { t: "error", code: "auth", msg: "Sign in to queue for ranked." });
      conn.close(4001, "auth");
      return;
    }

    const hold = await this.ctx.storage.get<ActiveHold>(holdKey(userId));
    const verdict = holdVerdict(hold, Date.now());
    if (verdict === "block") {
      this.send(conn, {
        t: "error",
        code: "in-match",
        msg: "You are in a live ranked match — finish it before queueing again.",
      });
      conn.close(4002, "in-match");
      return;
    }
    if (verdict === "stale") await this.ctx.storage.delete(holdKey(userId));

    // One presence per account: a second tab replaces the first.
    for (const other of this.getConnections()) {
      const st = other.state as QueueConnState;
      if (other !== conn && st?.userId === userId) other.close(4000, "replaced");
    }

    let name = "";
    try {
      name = sanitizeName(decodeURIComponent(rawName ?? ""));
    } catch {
      // A malformed header only costs the display name.
    }
    conn.setState({
      userId,
      name: name || DEFAULT_NAME,
      joinedAt: Date.now(),
    } satisfies QueueConnState);
    await this.reconcile();
  }

  async onClose() {
    await this.reconcile();
  }

  async onError(conn: Connection, _err: Error) {
    void conn;
    await this.reconcile();
  }

  /** Current members with their connections, as the policy derives them. */
  private members(): (QueueMember & { conn: Connection })[] {
    const entries: (QueueMember & { conn: Connection })[] = [];
    for (const conn of this.getConnections()) {
      const st = conn.state as QueueConnState;
      if (st?.userId) entries.push({ ...st, conn });
    }
    return queueMembers(entries);
  }

  async getQueueStatus(): Promise<RankedQueueStatus> {
    const deadline = (await this.ctx.storage.get<number>("deadline")) ?? null;
    return { count: this.members().length, deadline };
  }

  /** Ask the policy what the countdown should be, reconcile storage and the
   *  alarm slot to it, and deliver its sends. */
  private async reconcile() {
    const members = this.members();
    const stored = (await this.ctx.storage.get<number>("deadline")) ?? null;
    const { deadline, sends } = queuePolicy({ members, deadline: stored, now: Date.now() });
    if (deadline !== stored) {
      if (deadline == null) {
        await this.ctx.storage.delete("deadline");
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.put("deadline", deadline);
        await this.ctx.storage.setAlarm(deadline);
      }
    }
    members.forEach((member, index) => this.send(member.conn, sends[index]));
  }

  /** Countdown hit zero: the policy picks the match, this host births it. */
  async onAlarm() {
    await this.ctx.storage.delete("deadline");
    const matched = formMatch(this.members());
    if (matched) {
      const code = await this.freshCode();
      const roster: RankedRosterEntry[] = matched.map((m) => ({ userId: m.userId, name: m.name }));
      const ns = this.env.CoperoRankedRoom;
      let ok = false;
      try {
        const res = await ns.get(ns.idFromName(code)).fetch(RANKED_INIT_URL, {
          method: "POST",
          headers: {
            [RANKED_INTERNAL_HEADER]: RANKED_INTERNAL_TOKEN,
            "content-type": "application/json",
          },
          body: JSON.stringify({ roster }),
        });
        ok = res.ok;
      } catch (e) {
        console.error("ranked queue: room init failed:", e);
      }
      if (ok) {
        const now = Date.now();
        await this.ctx.storage.put(
          Object.fromEntries(
            matched.map((m) => [holdKey(m.userId), { code, at: now } satisfies ActiveHold]),
          ),
        );
        for (const m of matched) {
          this.send(m.conn, { t: "match", code });
          m.conn.close(1000, "matched");
        }
      }
      // On failure everyone simply stays queued; reconcile re-arms a fresh
      // countdown and the next alarm rolls a new code.
    }
    await this.reconcile();
  }

  /**
   * A room code that no completed match already owns — the code is also the
   * eternal ranked_match primary key, so a collision with history would make
   * the new match's result unrecordable. (A collision with a *live* room is
   * caught separately: its init call answers "already in use".)
   */
  private async freshCode(): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = makeRankedCode();
      const taken = await this.env.AUTH_DB.prepare("SELECT 1 FROM ranked_match WHERE id = ?")
        .bind(code)
        .first();
      if (!taken) return code;
    }
    throw new Error("could not mint an unused ranked code");
  }

  /** The ranked room reports a finished match: free its players to queue. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (
      url.pathname !== RANKED_RELEASE_PATH ||
      request.method !== "POST" ||
      request.headers.get(RANKED_INTERNAL_HEADER) !== RANKED_INTERNAL_TOKEN
    ) {
      return new Response("Not found", { status: 404 });
    }
    const { code } = await request.json<{ code: string }>();
    const holds = await this.ctx.storage.list<ActiveHold>({ prefix: "active:" });
    const done = releasedHoldKeys(holds, code);
    if (done.length) await this.ctx.storage.delete(done);
    return Response.json({ ok: true });
  }

  private send(conn: Connection, msg: QueueServerMsg) {
    conn.send(JSON.stringify(msg));
  }
}
