import usePartySocket from "partysocket/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMsg, RoomSnapshot, ServerMsg } from "../../mp/protocol";

const PLAYER_ID_KEY = "copero-player-id";

/** Stable per-browser identity — survives reloads, powers reconnects. */
export function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export function useRoom(code: string, name: string) {
  const [playerId] = useState(getPlayerId);
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  // Freeze the name at mount so typing elsewhere never churns the socket.
  const nameRef = useRef(name);
  const query = useMemo(
    () => ({ playerId, name: nameRef.current }),
    [playerId],
  );

  const socket = usePartySocket({
    party: "copero-room",
    room: code,
    query,
    onMessage(e) {
      const m = JSON.parse(e.data as string) as ServerMsg;
      if (m.t === "snapshot") setSnapshot(m.room);
      else if (m.code === "room-locked" || m.code === "no-player-id") setLocked(m.msg);
      else setLastError(m.msg);
    },
  });

  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(() => setLastError(null), 3500);
    return () => clearTimeout(t);
  }, [lastError]);

  const send = useCallback((m: ClientMsg) => socket.send(JSON.stringify(m)), [socket]);
  return { playerId, snapshot, send, lastError, locked };
}

/** Re-renders on an interval — for countdowns. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
