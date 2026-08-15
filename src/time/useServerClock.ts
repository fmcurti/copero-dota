import { useEffect, useState } from "react";
import { serverClock, synchronizeServerClock } from "./serverClock";

const RESYNC_MS = 60_000;

/** Keep the app-wide clock fresh across long sessions and sleeping tabs. */
export function useServerClockSync() {
  useEffect(() => {
    const sync = () => void synchronizeServerClock();
    const wake = () => {
      if (document.visibilityState === "visible") sync();
    };

    sync();
    const timer = window.setInterval(sync, RESYNC_MS);
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", sync);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", sync);
    };
  }, []);
}

/** Re-render from the synchronized monotonic clock; null until the first sample. */
export function useServerNow(ms: number): number | null {
  const [now, setNow] = useState(() => serverClock.now());
  useEffect(() => {
    const tick = () => setNow(serverClock.now());
    const unsubscribe = serverClock.subscribe(tick);
    const timer = window.setInterval(tick, ms);
    void synchronizeServerClock();
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [ms]);
  return now;
}
