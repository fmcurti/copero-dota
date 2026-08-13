import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import usePartySocket from "partysocket/react";
import { authClient } from "../../auth/client";
import { Section } from "../../components/options";
import {
  RANKED_MIN_PLAYERS,
  parseQueueServerMsg,
} from "../../ranked/protocol";
import { STARTING_RATING } from "../../ranked/rating";
import { useNow } from "../mp/useRoom";

// ---------------------------------------------------------------------------
// The ranked hub (docs/RANKED.md): the queue, the ladder, and your history in
// one place. The leaderboard is public; the queue and history need a session.
// Queue presence is the socket — leaving this page leaves the queue.
// ---------------------------------------------------------------------------

interface LeaderboardRow {
  userId: string;
  name: string;
  image: string | null;
  rating: number;
  gamesPlayed: number;
}

interface Profile {
  rating: number;
  gamesPlayed: number;
  rank: number | null;
}

interface HistoryRow {
  matchId: string;
  completedAt: number;
  teamName: string;
  place: number;
  gamesWon: number;
  ratingBefore: number;
  ratingExchange: number;
  ratingBonus: number;
  ratingAfter: number;
  players: number;
}

function useJson<T>(url: string | null): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    if (!url) {
      setData(null);
      return;
    }
    let live = true;
    void fetch(url, { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? (res.json() as Promise<T>) : null))
      .then((value) => {
        if (live && value) setData(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [url]);
  return data;
}

export default function Ranked() {
  const { data: session, isPending } = authClient.useSession();
  const userId = session?.user.id ?? null;
  const profile = useJson<Profile>(userId ? "/api/ranked/me" : null);
  const history = useJson<{ rows: HistoryRow[] }>(userId ? "/api/ranked/history" : null);
  const board = useJson<{ rows: LeaderboardRow[] }>("/api/ranked/leaderboard");

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
            {RANKED_MIN_PLAYERS}–8 drafters
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
        {userId && history?.rows.length ? (
          <Section label="Your matches">
            <div className="w-full space-y-1">
              {history.rows.map((row) => {
                const delta = row.ratingExchange + row.ratingBonus;
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
            {board?.rows.length ? (
              board.rows.map((row, i) => (
                <div
                  key={row.userId}
                  className={`flex items-baseline gap-3 rounded-lg px-3 py-2 text-sm ${
                    row.userId === userId ? "panel border border-bone/40" : "panel"
                  }`}
                >
                  <span className="w-8 shrink-0 font-mono text-xs text-slate-dim">#{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-semibold text-bone">
                    {row.name}
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

function QueuePanel() {
  const [queued, setQueued] = useState(false);
  if (!queued) {
    return (
      <div className="w-full space-y-3 text-center">
        <button
          onClick={() => setQueued(true)}
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
  return <QueueSocket onLeave={() => setQueued(false)} />;
}

/** Mounted = queued. Unmounting closes the socket, which leaves the queue. */
function QueueSocket({ onLeave }: { onLeave: () => void }) {
  const navigate = useNavigate();
  const [state, setState] = useState<{ count: number; position: number; deadline: number | null } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow(250);

  usePartySocket({
    party: "copero-ranked-queue",
    room: "main",
    onMessage(event) {
      let decoded: unknown;
      try {
        decoded = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const msg = parseQueueServerMsg(decoded);
      if (!msg) return;
      if (msg.t === "queue") {
        setState({ count: msg.count, position: msg.position, deadline: msg.deadline });
        setProblem(null);
      } else if (msg.t === "match") {
        navigate(`/ranked/${msg.code}`);
      } else {
        setProblem(msg.msg);
      }
    },
  });

  const secs =
    state?.deadline != null ? Math.max(0, Math.ceil((state.deadline - now) / 1000)) : null;

  return (
    <div className="w-full space-y-3 text-center">
      <div className="panel w-full rounded-xl px-4 py-4">
        {problem ? (
          <p className="text-sm text-dire">{problem}</p>
        ) : secs != null ? (
          <>
            <div className="plate font-mono text-4xl font-extrabold text-trophy">{secs}s</div>
            <p className="mt-1 text-xs text-slate-mid">
              Match found · {state!.count} players in · late joiners fill until start
            </p>
          </>
        ) : state ? (
          <>
            <div className="plate font-mono text-4xl font-extrabold text-bone">
              {state.count}/{RANKED_MIN_PLAYERS}
            </div>
            <p className="mt-1 text-xs text-slate-mid">
              Waiting for players · #{state.position} in queue
            </p>
          </>
        ) : (
          <p className="text-sm text-slate-dim">Joining queue…</p>
        )}
      </div>
      <div className="flex items-center justify-center gap-4">
        <button
          onClick={onLeave}
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
