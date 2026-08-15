import { create } from "zustand";
import type { DissolvedCheck, QueueServerMsg, ReadySlot } from "./protocol";

// ---------------------------------------------------------------------------
// Client-side queue state, held globally so matchmaking follows the player
// around the site the way Dota's does: the Ranked page joins, QueueDock
// renders the surfaces (bottom-right finder → ready modal → waiting grid),
// and the socket driver the dock mounts feeds frames in. Presence is the
// socket: queued mounts it, leaving drops it — and dropping it mid-check is
// how a match is declined.
// ---------------------------------------------------------------------------

export interface CheckView {
  deadline: number;
  /** Your own accept. Set optimistically on click; the server confirms. */
  accepted: boolean;
  players: ReadySlot[];
}

/** The formed match, held on screen all-green for a beat (Dota's reveal)
 *  before the dock navigates into the room. */
export interface MatchedView {
  code: string;
  players: ReadySlot[];
}

interface QueueStore {
  /** queued = the socket driver is mounted. */
  queued: boolean;
  /** When this search began — the finder's elapsed clock. */
  startedAt: number;
  count: number;
  position: number;
  /** The fill countdown's deadline — "match imminent" — when armed. */
  fillDeadline: number | null;
  check: CheckView | null;
  /** A check we sat in just failed — held briefly so the grid can show the
   *  red squares before the finder takes back over. */
  dissolved: DissolvedCheck | null;
  /** Our match formed — the all-green grid holds until the dock navigates.
   *  Outlives queued: the socket is done, the reveal is not. */
  matched: MatchedView | null;
  /** Transient feedback: kicked, replaced by another tab, check dissolved… */
  notice: string | null;

  join: () => void;
  /** Drop the socket. During a ready check, this is the decline. */
  leave: () => void;
  accept: () => void;
  clearNotice: () => void;
  clearDissolved: () => void;
  /** The match frame landed: freeze the grid all-green and let the driver
   *  unmount (queued off) so partysocket can't fight the server's goodbye. */
  applyMatch: (code: string) => void;
  clearMatched: () => void;

  // ---- driver wiring ----
  applyQueue: (msg: Extract<QueueServerMsg, { t: "queue" }>) => void;
  applyReady: (msg: Extract<QueueServerMsg, { t: "ready" }>) => void;
  applyError: (msg: Extract<QueueServerMsg, { t: "error" }>) => void;
  /** Terminal server close — drop to idle without touching the notice the
   *  error frame just set. */
  drop: (notice: string | null) => void;
  bindSend: (send: ((raw: string) => void) | null) => void;
}

/** Elapsed queue time, Dota style: unpadded minutes, padded seconds. */
export function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The driver's socket sender — a plain ref, not state: nothing renders it. */
let sendRaw: ((raw: string) => void) | null = null;

export const useQueueStore = create<QueueStore>((set, get) => ({
  queued: false,
  startedAt: 0,
  count: 0,
  position: 0,
  fillDeadline: null,
  check: null,
  dissolved: null,
  matched: null,
  notice: null,

  join: () =>
    set({
      queued: true,
      startedAt: Date.now(),
      count: 0,
      position: 0,
      fillDeadline: null,
      check: null,
      dissolved: null,
      matched: null,
      notice: null,
    }),

  leave: () => set({ queued: false, fillDeadline: null, check: null, dissolved: null }),

  accept: () => {
    const { check } = get();
    if (!check || check.accepted) return;
    sendRaw?.(JSON.stringify({ t: "accept" }));
    set({ check: { ...check, accepted: true } });
  },

  clearNotice: () => set({ notice: null }),
  clearDissolved: () => set({ dissolved: null }),

  applyMatch: (code) =>
    set((state) => ({
      queued: false,
      fillDeadline: null,
      check: null,
      dissolved: null,
      notice: null,
      matched: {
        code,
        players: (state.check?.players ?? []).map((p) => ({ ...p, accepted: true })),
      },
    })),

  clearMatched: () => set({ matched: null }),

  applyQueue: (msg) =>
    set((state) => ({
      count: msg.count,
      position: msg.position,
      fillDeadline: msg.deadline,
      check: null,
      // A dissolved echo (or a queue frame while we sat in a check) means
      // the check failed under us. Show the red squares, and say so —
      // silence reads as a glitch.
      dissolved: msg.dissolved ?? state.dissolved,
      notice: msg.dissolved || state.check ? "A player failed to accept" : state.notice,
    })),

  applyReady: (msg) =>
    set((state) => ({
      fillDeadline: null,
      notice: null,
      dissolved: null,
      check: {
        deadline: msg.deadline,
        // Keep an optimistic accept through broadcasts that predate ours.
        accepted:
          msg.accepted ||
          (state.check?.deadline === msg.deadline && state.check.accepted),
        players: msg.players,
      },
    })),

  // Error frames are terminal — the server closes the socket right after
  // sending one, and locally that close doesn't always surface. The frame
  // itself is the goodbye: drop to idle and show why.
  applyError: (msg) =>
    set({ queued: false, fillDeadline: null, check: null, dissolved: null, notice: msg.msg }),

  drop: (notice) =>
    set((state) => ({
      queued: false,
      fillDeadline: null,
      check: null,
      dissolved: null,
      notice: notice ?? state.notice,
    })),

  bindSend: (send) => {
    sendRaw = send;
  },
}));

// The screenshot/dev harness drives the store directly; dead code in builds.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__queueStore = useQueueStore;
}
