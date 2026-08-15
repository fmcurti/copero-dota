import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import usePartySocket from "partysocket/react";
import { announce } from "../mp/announcer";
import { secsUntil, useNow } from "../mp/useRoom";
import {
  RANKED_ACCEPT_MS,
  RANKED_MIN_PLAYERS,
  parseQueueServerMsg,
  type DissolvedCheck,
  type ReadySlot,
} from "../../ranked/protocol";
import {
  fmtClock,
  useQueueStore,
  type CheckView,
  type MatchedView,
} from "../../ranked/queueStore";

// ---------------------------------------------------------------------------
// The Dota matchmaking surfaces, floating over every page (mounted in App):
//
// - FINDING MATCH — the bottom-right finder: params strip, elapsed clock,
//   the red ✕ that cancels the search.
// - YOUR GAME IS READY — the center accept dialog over the green burst, with
//   the horn, when the fill countdown locks a ready check.
// - WAITING FOR PLAYERS — after accepting: one seat per locked player,
//   lighting up green (avatar when they have one) as accepts land.
//
// State lives in useQueueStore; the socket driver below feeds it. Leaving —
// the ✕, Decline Match, closing the tab — is one gesture: drop the socket.
// ---------------------------------------------------------------------------

/** How long the all-green grid holds after everyone accepts — the Dota
 *  beat where you savor the 4/4 before the match takes you. */
const MATCH_REVEAL_MS = 5000;

export default function QueueDock() {
  const navigate = useNavigate();
  const queued = useQueueStore((s) => s.queued);
  const check = useQueueStore((s) => s.check);
  const dissolved = useQueueStore((s) => s.dissolved);
  const matched = useQueueStore((s) => s.matched);
  const notice = useQueueStore((s) => s.notice);

  // Feedback expires on its own — the finder line and the idle toast both.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => useQueueStore.getState().clearNotice(), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The failed check's red squares hold the stage for a beat, then the
  // finder takes back over.
  useEffect(() => {
    if (!dissolved) return;
    const timer = setTimeout(() => useQueueStore.getState().clearDissolved(), 2400);
    return () => clearTimeout(timer);
  }, [dissolved]);

  // The match reveal: hold the full-green grid, then enter the room. (If the
  // grid never rendered — no ready frame survived — skip straight in.)
  useEffect(() => {
    if (!matched) return;
    const timer = setTimeout(
      () => {
        const code = matched.code;
        useQueueStore.getState().clearMatched();
        navigate(`/ranked/${code}`);
      },
      matched.players.length ? MATCH_REVEAL_MS : 0,
    );
    return () => clearTimeout(timer);
  }, [matched, navigate]);

  return (
    <>
      {queued && <QueueSocketDriver />}
      {queued && !check && dissolved && <DissolvedPanel dissolved={dissolved} />}
      {queued && !check && !dissolved && <MatchFinder />}
      {((queued && check) || (matched && matched.players.length > 0)) && (
        <CheckStage check={queued ? check : null} matched={matched} />
      )}
      {!queued && notice && (
        <div className="beat-in fixed bottom-4 right-4 z-40">
          <div className="panel rounded-lg border-dire-dim px-4 py-3 text-sm text-dire">
            {notice}
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// The socket driver. Mounted = queued; unmounting closes the socket, which
// leaves the queue (and declines a live check).
// ---------------------------------------------------------------------------

/** The Dota match-found moment: the horn (tamed by the announcer's per-clip
 *  gain — the clip is mastered hot), and a notification if the tab is hidden
 *  (the accept window runs whether or not the player is looking). */
function alertMatchFound() {
  announce("matchFound");
  notifyHidden("Match found", "Your ranked draft is ready — accept now.");
}

function notifyHidden(title: string, body: string) {
  if (document.hidden && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon-180.png" });
  }
}

function QueueSocketDriver() {
  // One horn per check, one heads-up per fill countdown — deadlines are the
  // identity of both.
  const horned = useRef<number | null>(null);
  const headsUp = useRef<number | null>(null);

  const socket = usePartySocket({
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
      const store = useQueueStore.getState();
      if (msg.t === "match") {
        // No navigation here — the dock holds the all-green reveal first.
        store.applyMatch(msg.code);
      } else if (msg.t === "ready") {
        if (horned.current !== msg.deadline) {
          horned.current = msg.deadline;
          alertMatchFound();
        }
        store.applyReady(msg);
      } else if (msg.t === "queue") {
        if (msg.deadline != null && headsUp.current !== msg.deadline) {
          headsUp.current = msg.deadline;
          notifyHidden("Match imminent", "A ranked match is forming — be ready to accept.");
        }
        store.applyQueue(msg);
      } else {
        store.applyError(msg);
      }
    },
  });

  useEffect(() => {
    useQueueStore.getState().bindSend((raw) => socket.send(raw));
    return () => useQueueStore.getState().bindSend(null);
  }, [socket]);

  useEffect(() => {
    // Terminal closes carry the server's verdict — a partysocket retry would
    // only fight it (replaced tabs would leapfrog forever), so go idle.
    const onClose = (e: CloseEvent) => {
      const store = useQueueStore.getState();
      if (e.code === 4000) store.drop("Queue moved to another tab.");
      else if (e.code === 4001 || e.code === 4002 || e.code === 4003) store.drop(null);
    };
    socket.addEventListener("close", onClose);
    return () => socket.removeEventListener("close", onClose);
  }, [socket]);

  return null;
}

// ---------------------------------------------------------------------------
// FINDING MATCH — the bottom-right finder.
// ---------------------------------------------------------------------------

/** The Dota finder, beat for beat: a cool translucent strip, the params row
 *  with the cyan clock, then the glowing headline beside the red ✕. */
function MatchFinder() {
  const startedAt = useQueueStore((s) => s.startedAt);
  const count = useQueueStore((s) => s.count);
  const fillDeadline = useQueueStore((s) => s.fillDeadline);
  const notice = useQueueStore((s) => s.notice);
  const leave = useQueueStore((s) => s.leave);
  const now = useNow(250);
  const fillSecs = fillDeadline != null ? secsUntil(fillDeadline, now) : null;

  const params = notice ?? (
    fillSecs != null
      ? `Ranked match / locking in · ${fillSecs}`
      : `Ranked match / Classic draft / ${count} of ${RANKED_MIN_PLAYERS}`
  );

  return (
    <div className="beat-in fixed bottom-5 right-5 z-40">
      <div className="finder w-[400px] max-w-[calc(100vw-2.5rem)] rounded-[3px]">
        <div className="flex items-baseline justify-between gap-3 border-b border-[#8caac3]/15 px-4 pb-1.5 pt-2">
          <span
            className={`plate min-w-0 truncate text-[11px] tracking-[0.2em] ${
              notice ? "text-dire" : "text-[#8fa3b0]"
            }`}
          >
            {params}
          </span>
          <span className="font-mono text-[15px] tabular-nums leading-none text-[#9fd4e8]">
            {fmtClock(now - startedAt)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          {fillSecs != null ? (
            <div className="anim-urgent plate text-[27px] font-bold leading-none tracking-[0.14em] text-trophy">
              Confirming match
            </div>
          ) : (
            <div className="finding-glow plate text-[27px] font-bold leading-none tracking-[0.14em]">
              Finding match
            </div>
          )}
          <button
            onClick={leave}
            aria-label="Cancel matchmaking"
            className="cta-dota grid h-11 w-11 shrink-0 place-items-center rounded-[3px] text-xl font-bold leading-none"
          >
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ready check overlays. The accept dialog and the waiting grid are two
// faces of one 3D stage over the green burst: accepting rolls the cube —
// the dialog tips away and the grid rides in on the next face, as in Dota.
// ---------------------------------------------------------------------------

/** The dialog chrome both faces share: header band, body, timer bar. */
function CheckCard({
  eyebrow,
  labelId,
  barFrac,
  children,
}: {
  eyebrow: string;
  labelId: string;
  barFrac: number;
  children: React.ReactNode;
}) {
  return (
    <div className="panel flex h-full w-full flex-col overflow-hidden rounded-sm">
      <div className="border-b border-ink-700/80 bg-ink-950/60 px-6 pb-4 pt-5 text-center">
        <div className="plate text-base tracking-[0.35em] text-slate-strong">{eyebrow}</div>
        <div
          id={labelId}
          className="plate mt-1 text-3xl font-extrabold tracking-[0.12em] text-bone"
        >
          Ranked draft
        </div>
      </div>
      {children}
      <div className="mt-auto h-[3px] w-full bg-ink-800">
        <div
          className="h-full bg-radiant/80"
          style={{ width: `${barFrac * 100}%`, transition: "width 200ms linear" }}
        />
      </div>
    </div>
  );
}

/** Standalone overlay for a single card (the dissolved epitaph). */
function CheckShell({
  eyebrow,
  deadline,
  labelId,
  children,
}: {
  eyebrow: string;
  deadline: number;
  labelId: string;
  children: React.ReactNode;
}) {
  const now = useNow(200);
  const frac = Math.min(1, Math.max(0, deadline - now) / RANKED_ACCEPT_MS);
  return (
    <div className="fixed inset-0 z-[60] grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/70" />
      <div className="ready-bloom absolute inset-0" />
      <div className="anim-title-in relative w-[min(94vw,600px)]">
        <CheckCard eyebrow={eyebrow} labelId={labelId} barFrac={frac}>
          {children}
        </CheckCard>
      </div>
    </div>
  );
}

/** Both faces stay mounted; `showGrid` rolls the cube. During the matched
 *  reveal the grid face holds all-green with a full bar. */
function CheckStage({ check, matched }: { check: CheckView | null; matched: MatchedView | null }) {
  const accept = useQueueStore((s) => s.accept);
  const leave = useQueueStore((s) => s.leave);
  const now = useNow(200);
  const showGrid = matched != null || (check?.accepted ?? false);
  const barFrac = matched
    ? 1
    : Math.min(1, Math.max(0, (check?.deadline ?? 0) - now) / RANKED_ACCEPT_MS);
  const players = matched?.players ?? check?.players ?? [];
  const acceptedCount = players.filter((p) => p.accepted).length;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Ranked ready check"
      className="fixed inset-0 z-[60] grid place-items-center p-4"
    >
      <div className="absolute inset-0 bg-black/70" />
      <div className="ready-bloom absolute inset-0" />
      <div className="anim-title-in check-stage relative grid w-[min(94vw,600px)]">
        <div
          aria-hidden={showGrid}
          className={`check-face [grid-area:1/1] ${showGrid ? "check-face-out" : ""}`}
        >
          <CheckCard eyebrow="Your game is ready" labelId="ready-title" barFrac={barFrac}>
            <div className="relative px-6 pb-7 pt-8">
              <button
                autoFocus
                disabled={showGrid}
                onClick={accept}
                className="cta-accept plate mx-auto block w-64 max-w-full rounded-sm py-3.5 text-2xl font-bold tracking-[0.25em]"
              >
                Accept
              </button>
              <button
                disabled={showGrid}
                onClick={leave}
                className="absolute bottom-2 right-4 flex items-center gap-1.5 py-1 text-xs text-slate-mid transition hover:text-bone"
              >
                <span className="grid h-3.5 w-3.5 place-items-center rounded-full border border-current text-[9px] leading-none">
                  i
                </span>
                Decline Match
              </button>
            </div>
          </CheckCard>
        </div>
        <div
          aria-hidden={!showGrid}
          aria-live={showGrid ? "polite" : "off"}
          className={`check-face [grid-area:1/1] ${
            showGrid ? "check-face-enter" : "check-face-under"
          }`}
        >
          <CheckCard
            eyebrow={matched ? "All players ready" : "Waiting for players"}
            labelId="waiting-title"
            barFrac={barFrac}
          >
            <div className="flex flex-wrap justify-center gap-2 px-6 pt-6">
              {players.map((slot, i) => (
                <ReadySeat key={i} slot={slot} />
              ))}
            </div>
            <div className="px-6 pb-4 pt-3 text-right">
              <span className="plate text-sm tracking-[0.2em] text-bone">
                <span className="font-mono tabular-nums">
                  {acceptedCount} / {players.length}
                </span>{" "}
                accepted
              </span>
            </div>
          </CheckCard>
        </div>
      </div>
    </div>
  );
}

/** The check's epitaph, Dota style: the grid frozen for a beat with the
 *  slots that sank it burning red, then the finder takes back over. */
function DissolvedPanel({ dissolved }: { dissolved: DissolvedCheck }) {
  const accepted = dissolved.players.filter((p) => p.accepted).length;
  return (
    <div aria-live="assertive">
      <CheckShell eyebrow="Match declined" deadline={0} labelId="dissolved-title">
        <div className="flex flex-wrap justify-center gap-2 px-6 pt-6">
          {dissolved.players.map((slot, i) => (
            <ReadySeat key={i} slot={slot} failed={dissolved.failed.includes(i)} />
          ))}
        </div>
        <div className="px-6 pb-4 pt-3 text-right">
          <span className="plate text-sm tracking-[0.2em] text-dire">
            <span className="font-mono tabular-nums">
              {accepted} / {dissolved.players.length}
            </span>{" "}
            accepted
          </span>
        </div>
      </CheckShell>
    </div>
  );
}

/** failed wins over accepted: a player can accept and then walk out. */
function ReadySeat({ slot, failed }: { slot: ReadySlot; failed?: boolean }) {
  if (failed) {
    return (
      <div className="anim-dot-pop seat-failed grid h-14 w-14 place-items-center overflow-hidden rounded-md p-[2px]">
        {slot.image ? (
          <img
            src={slot.image}
            alt=""
            className="h-full w-full rounded-[4px] object-cover opacity-80"
          />
        ) : (
          <Silhouette className="h-8 w-8 text-[#f8e3dc]" />
        )}
      </div>
    );
  }
  if (!slot.accepted) {
    return (
      <div className="grid h-14 w-14 place-items-center rounded-md border border-ink-700 bg-ink-900">
        <Silhouette className="h-8 w-8 text-ink-600" />
      </div>
    );
  }
  return (
    <div className="anim-dot-pop seat-accepted grid h-14 w-14 place-items-center overflow-hidden rounded-md p-[2px]">
      {slot.image ? (
        <img src={slot.image} alt="" className="h-full w-full rounded-[4px] object-cover" />
      ) : (
        <Silhouette className="h-8 w-8 text-[#eaf6e6]" />
      )}
    </div>
  );
}

function Silhouette({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="12" cy="8.2" r="4.2" />
      <path d="M3.5 21c.6-4.6 4.1-7 8.5-7s7.9 2.4 8.5 7z" />
    </svg>
  );
}
