import usePartySocket from "partysocket/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRunStore } from "../../game/store";
import {
  RoomClientHost,
  type RoomClientOutcome,
  type RoomClientSession,
} from "../../mp/clientRoom";
import type { ClientMsg } from "../../mp/protocol";

const PLAYER_ID_KEY = "copero-player-id";

/** Stable per-browser identity — survives reloads, powers reconnects. */
function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

export interface RoomHostOptions {
  /** PartyServer party — ranked rooms live in their own class. */
  party?: string;
  /**
   * Identity override: ranked passes the signed-in user id so the client's
   * view lines up with the seat the server bound to the session. The server
   * never trusts this — it is only the lens the local view derives through.
   */
  playerId?: string;
}

/** React/WebSocket adapter for the deep client-side Room host. */
export function useRoomHost(
  code: string,
  name: string,
  preferSpectator: boolean,
  opts?: RoomHostOptions,
) {
  const party = opts?.party ?? "copero-room";
  const [browserId] = useState(getPlayerId);
  const playerId = opts?.playerId ?? browserId;
  const [session, setSession] = useState<RoomClientSession | null>(null);
  const [problemState, setProblemState] = useState<{
    code: string;
    problem: Extract<RoomClientOutcome, { kind: "problem" }>["problem"];
  } | null>(null);
  const [stinger, setStinger] = useState(false);
  const winPhrases = useRunStore((state) => state.winPhrases);
  const recordRun = useRunStore((state) => state.recordRun);

  const sendRawRef = useRef<(frame: string) => void>(() => {});
  const recordRunRef = useRef(recordRun);
  const phrasesKeyRef = useRef(winPhrases.join("\n"));
  recordRunRef.current = recordRun;
  phrasesKeyRef.current = winPhrases.join("\n");

  const hostRef = useRef<{ code: string; playerId: string; host: RoomClientHost } | null>(null);
  if (!hostRef.current || hostRef.current.code !== code || hostRef.current.playerId !== playerId) {
    hostRef.current = {
      code,
      playerId,
      host: new RoomClientHost(code, playerId, {
        sendRaw: (frame) => sendRawRef.current(frame),
        storage: localStorage,
        recordRun: (record) => recordRunRef.current(record),
        showStinger: () => setStinger(true),
        phrasesKey: () => phrasesKeyRef.current,
        now: Date.now,
      }),
    };
  }
  const host = hostRef.current.host;

  const nameRef = useRef(name);
  const preferSpectatorRef = useRef(preferSpectator);
  const arrivalCodeRef = useRef(code);
  if (arrivalCodeRef.current !== code) {
    arrivalCodeRef.current = code;
    nameRef.current = name;
    preferSpectatorRef.current = preferSpectator;
  }
  const query = useMemo(
    () => () => {
      const outcome = host.dispatch({
        type: "connect",
        preferSpectator: preferSpectatorRef.current,
      });
      preferSpectatorRef.current = false;
      return {
        playerId,
        name: nameRef.current,
        spectator: outcome.kind === "query" && outcome.spectator ? "1" : null,
      };
    },
    [host, playerId],
  );

  const socket = usePartySocket({
    party,
    room: code,
    query,
    onMessage(event) {
      const outcome = host.dispatch({ type: "frame", raw: event.data as string });
      if (outcome.kind === "session") {
        setSession(outcome.session);
        setProblemState(null);
      } else if (outcome.kind === "problem") {
        setProblemState({ code, problem: outcome.problem });
      }
    },
  });
  sendRawRef.current = (frame) => socket.send(frame);

  useEffect(() => {
    const onOpen = () => host.dispatch({ type: "open" });
    socket.addEventListener("open", onOpen);
    return () => socket.removeEventListener("open", onOpen);
  }, [host, socket]);

  useEffect(() => {
    host.dispatch({ type: "phrasesChanged" });
  }, [host, winPhrases]);

  useEffect(() => {
    const problem = problemState?.code === code ? problemState.problem : null;
    if (!problem || problem.fatal) return;
    const timer = setTimeout(() => setProblemState(null), 3500);
    return () => clearTimeout(timer);
  }, [code, problemState]);

  useEffect(() => setStinger(false), [code]);

  const send = useCallback(
    (message: ClientMsg) => host.dispatch({ type: "message", message }),
    [host],
  );
  const spectate = useCallback(() => host.dispatch({ type: "spectate" }), [host]);
  const takeSeat = useCallback(() => host.dispatch({ type: "takeSeat" }), [host]);
  const dismissStinger = useCallback(() => setStinger(false), []);
  const actions = useMemo(
    () => ({ send, spectate, takeSeat, dismissStinger }),
    [send, spectate, takeSeat, dismissStinger],
  );

  return {
    session: session?.code === code ? session : null,
    problem: problemState?.code === code ? problemState.problem : null,
    stinger,
    actions,
  };
}

/** Whole seconds until an epoch-ms deadline, floored at zero. */
export function secsUntil(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Re-renders on an interval — for countdowns. */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
