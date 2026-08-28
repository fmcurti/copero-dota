import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { authClient } from "../../auth/client";
import { Section } from "../../components/options";
import { preloadAnnouncer } from "../mp/announcer";
import {
  RANKED_MAX_PLAYERS,
  RANKED_MIN_PLAYERS,
  type RankedHub,
} from "../../ranked/protocol";
import { fmtClock, useQueueStore } from "../../ranked/queueStore";
import { STARTING_RATING } from "../../ranked/rating";
import { useNow } from "../mp/useRoom";

// ---------------------------------------------------------------------------
// The ranked hub (docs/RANKED.md): the queue, the ladder, and your history in
// one place, loaded in one request. The leaderboard is public; the queue and
// history need a session. Queue presence is the socket — leaving this page
// leaves the queue.
// ---------------------------------------------------------------------------

/** One-shot fetch; the session cookie decides how much the hub returns. */
function useHub(): RankedHub | null {
  const [data, setData] = useState<RankedHub | null>(null);
  useEffect(() => {
    let live = true;
    void fetch("/api/ranked/hub", { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<RankedHub>) : null))
      .then((value) => {
        if (live && value) setData(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return data;
}

export default function Ranked() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const hub = useHub();
  const profile = hub?.me ?? null;
  const history = hub?.history ?? null;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mx-auto mb-10 max-w-xl text-center">
        <div className="plate-rules py-4">
          <h1 className="anim-title-in plate text-5xl font-extrabold leading-none text-bone">
            Ranked
          </h1>
          <div
            className="anim-eyebrow-in plate ml-[0.4em] mt-1 text-lg text-slate-mid"
            style={{ animationDelay: "0.15s" }}
          >
            {RANKED_MIN_PLAYERS}–{RANKED_MAX_PLAYERS} drafters
          </div>
        </div>
        <p className="beat-in mt-3 text-sm text-slate-mid" style={{ animationDelay: "0.35s" }}>
          The first {RANKED_MIN_PLAYERS} players in the queue form a match. Rating on the line.
        </p>
      </div>

      <div className="mx-auto max-w-sm space-y-6">
        {isPending ? (
          <p className="text-center text-sm text-slate-dim">Loading session…</p>
        ) : userId ? (
          <>
            <Section label="Your rating">
              <div className="panel flex w-full items-center justify-between rounded-xl px-4 py-3">
                <div>
                  <div className="font-mono text-3xl font-extrabold text-bone">
                    {profile?.rating ?? STARTING_RATING}
                  </div>
                  <div className="text-[10px] tracking-widest text-slate-dim">
                    {profile?.gamesPlayed ?? 0} ranked games
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono text-xl text-trophy">
                    {profile?.rank != null ? `#${profile.rank}` : "—"}
                  </div>
                  <div className="text-[10px] tracking-widest text-slate-dim">ladder</div>
                </div>
              </div>
            </Section>
            <Section label="Queue">
              <QueuePanel />
            </Section>
          </>
        ) : (
          <Section label="Queue">
            <div className="panel w-full rounded-xl px-4 py-4 text-center text-sm text-slate-mid">
              Ranked requires an account — sign in from the header to queue.
              <div className="mt-2">
                <Link to="/" className="plate text-xs tracking-widest text-slate-dim hover:text-bone">
                  or play casual without an account →
                </Link>
              </div>
            </div>
          </Section>
        )}
      </div>

      <div className="mx-auto mt-10 max-w-xl space-y-8">
        {userId && history?.length ? (
          <Section label="Your matches">
            <div className="w-full space-y-1">
              {history.map((row) => {
                // after − before, not exchange + bonus: the floor clamp can
                // absorb part of a loss, and the shown delta must match.
                const delta = row.ratingAfter - row.ratingBefore;
                return (
                  <div
                    key={row.matchId}
                    className="panel flex items-baseline gap-3 rounded-lg px-3 py-2 text-sm"
                  >
                    <span className="shrink-0 font-mono text-xs text-slate-dim">
                      {new Date(row.completedAt).toLocaleDateString()}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-semibold text-bone">
                      {row.teamName}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-slate-mid">
                      top {row.place} · {row.players}p
                    </span>
                    <span
                      className={`shrink-0 font-mono text-sm font-bold ${
                        delta >= 0 ? "text-trophy" : "text-dire"
                      }`}
                    >
                      {delta >= 0 ? "+" : ""}
                      {delta}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-slate-dim">
                      {row.ratingAfter}
                    </span>
                  </div>
                );
              })}
            </div>
          </Section>
        ) : null}

        <Section label="Leaderboard">
          <div className="w-full space-y-1">
            {hub?.leaderboard.length ? (
              hub.leaderboard.map((row, i) => (
                <div
                  key={row.userId}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
                    row.userId === userId ? "panel border border-bone/40" : "panel"
                  }`}
                >
                  <span className="w-8 shrink-0 font-mono text-xs text-slate-dim">#{i + 1}</span>
                  <span className="flex min-w-0 flex-1 flex-col leading-tight">
                    <span className="truncate font-semibold text-bone">{row.name}</span>
                    <span className="truncate text-xs text-slate-dim">{row.account}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs text-slate-dim">
                    {row.gamesPlayed}g
                  </span>
                  <span className="shrink-0 font-mono text-base font-bold text-trophy">
                    {row.rating}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-center text-sm text-slate-dim">No ranked games yet.</p>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Join here; from then on the QueueDock (mounted app-wide) runs the show —
 *  the finder, the ready check, the waiting grid all float over any page. */
function QueuePanel() {
  const queued = useQueueStore((s) => s.queued);
  const count = useQueueStore((s) => s.count);
  const position = useQueueStore((s) => s.position);
  const startedAt = useQueueStore((s) => s.startedAt);
  const join = useQueueStore((s) => s.join);
  const leave = useQueueStore((s) => s.leave);
  const now = useNow(500);

  if (!queued) {
    return (
      <div className="w-full space-y-3 text-center">
        <button
          onClick={() => {
            // The click is the user gesture: warm the announcer so the
            // match-found horn can play later, and ask to notify a hidden tab.
            preloadAnnouncer();
            if ("Notification" in window && Notification.permission === "default") {
              void Notification.requestPermission();
            }
            join();
          }}
          className="cta-dota plate w-full rounded-lg py-4 text-lg font-bold tracking-widest"
        >
          Join Queue
        </button>
        <Link to="/" className="plate inline-block text-xs tracking-widest text-slate-mid hover:text-bone">
          play casual instead →
        </Link>
      </div>
    );
  }

  return (
    <div className="w-full space-y-3 text-center">
      <div className="panel w-full rounded-xl px-4 py-4">
        <div className="plate font-mono text-4xl font-extrabold text-bone">
          {count}/{RANKED_MIN_PLAYERS}
        </div>
        <p className="mt-1 text-xs text-slate-mid">
          Searching {fmtClock(now - startedAt)} · #{Math.max(position, 1)} in queue — the
          finder follows you anywhere on the site
        </p>
      </div>
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={leave}
          className="rounded-lg border border-ink-600 px-5 py-2 text-sm font-semibold text-slate-strong hover:border-slate-mid hover:text-bone"
        >
          Leave queue
        </button>
        <Link to="/" className="plate text-xs tracking-widest text-slate-mid hover:text-bone">
          play casual instead →
        </Link>
      </div>
    </div>
  );
}
