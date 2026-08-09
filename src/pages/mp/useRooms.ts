import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomListing } from "../../mp/directory";

const POLL_MS = 15_000;

/**
 * Live view of the room directory.
 *
 * Polled rather than subscribed: lobbies live for minutes, so a socket would
 * buy a few seconds of freshness in exchange for a public websocket surface
 * and reconnect handling on a page that currently has none. Hidden tabs stop
 * polling entirely and catch up on focus.
 */
export function useRooms() {
  const [rooms, setRooms] = useState<RoomListing[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** Server clock minus ours — freshness must not depend on the user's clock. */
  const skew = useRef(0);
  const tick = useRef<() => void>(() => {});

  useEffect(() => {
    let dead = false;
    let timer: number | undefined;

    const load = async () => {
      try {
        const res = await fetch("/api/rooms", { headers: { accept: "application/json" } });
        const ct = res.headers.get("content-type") ?? "";
        // The SPA fallback answers unknown paths with index.html and a 200 —
        // fail loudly instead of rendering an empty list forever.
        if (!res.ok || !ct.includes("json")) throw new Error(`${res.status} ${ct}`);
        const json = (await res.json()) as { now: number; rooms: RoomListing[] };
        if (dead) return;
        skew.current = json.now - Date.now();
        setRooms(json.rooms);
        setError(null);
      } catch (e) {
        if (!dead) setError(String(e));
      } finally {
        if (!dead) setLoaded(true);
      }
    };

    const schedule = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => {
        void load();
        schedule();
      }, POLL_MS);
    };
    tick.current = () => {
      void load();
      schedule();
    };

    tick.current();
    const wake = () => {
      if (document.visibilityState === "visible") tick.current();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      dead = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, []);

  const now = useCallback(() => Date.now() + skew.current, []);
  const refresh = useCallback(() => tick.current(), []);
  return { rooms, now, loaded, error, refresh };
}
