import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { DEFAULT_NAME, sanitizeName } from "../src/mp/protocol";
import {
  acceptCheck,
  holdVerdict,
  queueMembers,
  queuePolicy,
  releasedHoldKeys,
  type ActiveHold,
  type QueueMember,
} from "../src/ranked/queue";
import {
  makeRankedCode,
  parseQueueClientMsg,
  type QueueServerMsg,
  type RankedQueueStatus,
  type ReadyCheck,
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
// queue — and closing during a ready check is how a match is declined. The
// one frame a client ever sends is the accept.
//
// The Worker validates the session at the upgrade; identity arrives in the
// same internal headers the ranked room trusts. No session, no socket.
// ---------------------------------------------------------------------------

type QueueConnState = QueueMember | null;

const holdKey = (userId: string) => `active:${userId}`;

/** Above this an avatar stays home (silhouette instead): a ready frame
 *  carries up to 8 of them and a DO websocket message tops out at 1MiB. */
const MAX_QUEUE_AVATAR_CHARS = 100_000;

export class CoperoRankedQueue extends Server<Env> {
  static options = { hibernate: true };

  /** The live check's avatars — in-memory only, so it may survive nothing:
   *  a post-hibernation miss just re-reads D1. */
  private checkImages: { key: string; images: Map<string, string | null> } | null = null;

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

    // One presence per account: a second tab replaces the first. The frame
    // precedes the close because error frames are the terminal signal — a
    // close code alone doesn't reliably reach the local-dev client.
    for (const other of this.getConnections()) {
      const st = other.state as QueueConnState;
      if (other !== conn && st?.userId === userId) {
        this.send(other, { t: "error", code: "replaced", msg: "Queue moved to your newer tab." });
        other.close(4000, "replaced");
      }
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

  /** The accept — the only thing a queue client ever says. */
  async onMessage(conn: Connection, message: WSMessage) {
    const st = conn.state as QueueConnState;
    if (!st?.userId || typeof message !== "string") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(message);
    } catch {
      return;
    }
    if (!parseQueueClientMsg(decoded)) return;
    const check = (await this.ctx.storage.get<ReadyCheck>("check")) ?? null;
    const next = acceptCheck(check, st.userId);
    if (next === check) return;
    await this.ctx.storage.put("check", next);
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

  private async phase(): Promise<{ fillDeadline: number | null; check: ReadyCheck | null }> {
    const stored = await this.ctx.storage.get<number | ReadyCheck>(["deadline", "check"]);
    return {
      fillDeadline: (stored.get("deadline") as number | undefined) ?? null,
      check: (stored.get("check") as ReadyCheck | undefined) ?? null,
    };
  }

  async getQueueStatus(): Promise<RankedQueueStatus> {
    const { fillDeadline, check } = await this.phase();
    return { count: this.members().length, deadline: check?.deadline ?? fillDeadline };
  }

  /** Ask the policy what the machine should now hold, reconcile storage and
   *  the alarm slot to it, and deliver its verdicts. */
  private async reconcile() {
    const members = this.members();
    const before = await this.phase();
    const d = queuePolicy({ members, ...before, now: Date.now() });

    if (d.fillDeadline !== before.fillDeadline) {
      if (d.fillDeadline == null) await this.ctx.storage.delete("deadline");
      else await this.ctx.storage.put("deadline", d.fillDeadline);
    }
    if (d.check !== before.check) {
      if (d.check == null) await this.ctx.storage.delete("check");
      else await this.ctx.storage.put("check", d.check);
    }
    const alarmBefore = before.check?.deadline ?? before.fillDeadline;
    const alarmAfter = d.check?.deadline ?? d.fillDeadline;
    if (alarmAfter !== alarmBefore) {
      if (alarmAfter == null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(alarmAfter);
    }

    if (d.match) {
      await this.birthMatch(d.match);
      // Whoever is still waiting re-arms a fresh countdown and hears about it.
      await this.reconcile();
      return;
    }

    // Avatars ride the ready frames and the dissolved echo; the policy left
    // null placeholders in check order, so the fill-in is by index against
    // the (live or just-dissolved) check's userIds.
    const images = d.check ? await this.imagesFor(d.check) : null;
    const echoImages = d.dissolvedCheck ? await this.imagesFor(d.dissolvedCheck) : null;
    members.forEach((member, index) => {
      let msg = d.sends[index];
      if (msg.t === "ready" && images) {
        msg = {
          ...msg,
          players: msg.players.map((slot, i) => ({
            ...slot,
            image: images.get(d.check!.userIds[i]) ?? null,
          })),
        };
      } else if (msg.t === "queue" && msg.dissolved && echoImages) {
        msg = {
          ...msg,
          dissolved: {
            ...msg.dissolved,
            players: msg.dissolved.players.map((slot, i) => ({
              ...slot,
              image: echoImages.get(d.dissolvedCheck!.userIds[i]) ?? null,
            })),
          },
        };
      }
      this.send(member.conn, msg);
      if (d.kicks.includes(member.userId)) member.conn.close(4003, "no-accept");
    });
  }

  /** A deadline landed — the fill locks a check, or the check expires and
   *  kicks its sleepers. The policy decides which; the host only reconciles. */
  async onAlarm() {
    await this.reconcile();
  }

  /** Everyone accepted: mint the room, seat the roster, deliver the match. */
  private async birthMatch(matched: (QueueMember & { conn: Connection })[]) {
    let code: string;
    try {
      code = await this.freshCode();
    } catch (e) {
      console.error("ranked queue: no fresh code:", e);
      return;
    }
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
    // On failure everyone simply stays queued; the caller reconciles, a fresh
    // countdown arms, and the next check rolls a new code.
  }

  /**
   * The locked roster's avatars, one D1 read per check (memoized in memory —
   * hibernation just costs a re-read). A failed read means silhouettes for
   * everyone; the check itself must not care.
   */
  private async imagesFor(check: ReadyCheck): Promise<Map<string, string | null>> {
    const key = `${check.deadline}:${check.userIds.join(",")}`;
    if (this.checkImages?.key === key) return this.checkImages.images;
    const images = new Map<string, string | null>(check.userIds.map((id) => [id, null]));
    try {
      const marks = check.userIds.map(() => "?").join(",");
      const rows = await this.env.AUTH_DB.prepare(
        `SELECT id, image FROM user WHERE id IN (${marks})`,
      )
        .bind(...check.userIds)
        .all<{ id: string; image: string | null }>();
      for (const row of rows.results) {
        if (row.image && row.image.length <= MAX_QUEUE_AVATAR_CHARS) {
          images.set(row.id, row.image);
        }
      }
    } catch (e) {
      console.error("ranked queue: avatar read failed:", e);
    }
    this.checkImages = { key, images };
    return images;
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
