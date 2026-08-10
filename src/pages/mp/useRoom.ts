import usePartySocket from "partysocket/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMsg, RoomSnapshot, ServerMsg } from "../../mp/protocol";

const PLAYER_ID_KEY = "copero-player-id";
const spectatorKey = (code: string) => `copero-mp-spectator:${code}`;

/**
 * Arrive as a viewer instead of taking a seat. Must be set BEFORE the room
 * page mounts — useRoom reads it once, when it opens the socket.
 */
export function watchOnly(code: string) {
  localStorage.setItem(spectatorKey(code), "1");
}

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
  const [fatalError, setFatalError] = useState<string | null>(null);
  // Freeze the name at mount so typing elsewhere never churns the socket.
  const nameRef = useRef(name);
  const query = useMemo(
    () => () => ({
      playerId,
      name: nameRef.current,
      spectator: localStorage.getItem(spectatorKey(code)) === "1" ? "1" : null,
    }),
    [code, playerId],
  );

  const socket = usePartySocket({
    party: "copero-room",
    room: code,
    query,
    onMessage(e) {
      const m = JSON.parse(e.data as string) as ServerMsg;
      if (m.t === "snapshot") setSnapshot(m.room);
      else if (m.fatal) setFatalError(m.msg);
      else setLastError(m.msg);
    },
  });

  // Bumps on every (re)connect — lets effects re-sync state the server may
  // have never received (e.g. win phrases sent to a worker that restarted).
  const [opens, setOpens] = useState(0);
  useEffect(() => {
    const onOpen = () => setOpens((n) => n + 1);
    socket.addEventListener("open", onOpen);
    return () => socket.removeEventListener("open", onOpen);
  }, [socket]);

  useEffect(() => {
    if (!lastError) return;
    const t = setTimeout(() => setLastError(null), 3500);
    return () => clearTimeout(t);
  }, [lastError]);

  const send = useCallback((m: ClientMsg) => socket.send(JSON.stringify(m)), [socket]);
  const spectate = useCallback(() => {
    localStorage.setItem(spectatorKey(code), "1");
    socket.send(JSON.stringify({ t: "spectate" } satisfies ClientMsg));
  }, [code, socket]);
  const takeSeat = useCallback(() => {
    localStorage.removeItem(spectatorKey(code));
    socket.send(JSON.stringify({ t: "takeSeat" } satisfies ClientMsg));
  }, [code, socket]);
  return { playerId, snapshot, send, spectate, takeSeat, lastError, fatalError, opens };
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
