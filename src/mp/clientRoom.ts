import { simulateTournament } from "../game/sim";
import type { RunRecord, SimResult } from "../game/types";
import {
  parseServerMsg,
  type ClientMsg,
  type RoomSnapshot,
} from "./protocol";
import {
  deriveRoomView,
  roomCues,
  type ClientFacts,
  type RoomView,
} from "./roomView";

const spectatorKey = (code: string) => `copero-mp-spectator:${code}`;

export interface RoomClientStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RoomClientAdapters {
  sendRaw(frame: string): void;
  storage: RoomClientStorage;
  recordRun(record: RunRecord): void;
  showStinger(): void;
  phrasesKey(): string;
  now(): number;
}

export interface RoomClientSession {
  code: string;
  playerId: string;
  snapshot: RoomSnapshot;
  result: SimResult | null;
  view: RoomView;
}

export interface RoomClientProblem {
  fatal: boolean;
  message: string;
}

export type RoomClientEvent =
  | { type: "connect"; preferSpectator: boolean }
  | { type: "frame"; raw: string }
  | { type: "open" }
  | { type: "phrasesChanged" }
  | { type: "message"; message: ClientMsg }
  | { type: "spectate" }
  | { type: "takeSeat" };

export type RoomClientOutcome =
  | { kind: "none" }
  | { kind: "query"; spectator: boolean }
  | { kind: "session"; session: RoomClientSession }
  | { kind: "problem"; problem: RoomClientProblem };

/**
 * Client-side Room host. One event interface owns the complete lifecycle;
 * React, WebSocket, localStorage, and run history sit outside as adapters.
 */
export class RoomClientHost {
  private session: RoomClientSession | null = null;
  private previousFacts: ClientFacts | null = null;
  private opens = 0;

  constructor(
    private readonly code: string,
    private readonly playerId: string,
    private readonly adapters: RoomClientAdapters,
  ) {}

  dispatch(event: RoomClientEvent): RoomClientOutcome {
    switch (event.type) {
      case "connect": {
        if (event.preferSpectator) {
          this.adapters.storage.setItem(spectatorKey(this.code), "1");
        }
        return {
          kind: "query",
          spectator: this.adapters.storage.getItem(spectatorKey(this.code)) === "1",
        };
      }
      case "frame":
        return this.receive(event.raw);
      case "open":
        this.opens++;
        this.reconcile();
        return { kind: "none" };
      case "phrasesChanged":
        this.reconcile();
        return { kind: "none" };
      case "message":
        this.send(event.message);
        return { kind: "none" };
      case "spectate":
        this.adapters.storage.setItem(spectatorKey(this.code), "1");
        this.send({ t: "spectate" });
        return { kind: "none" };
      case "takeSeat":
        this.adapters.storage.removeItem(spectatorKey(this.code));
        this.send({ t: "takeSeat" });
        return { kind: "none" };
    }
  }

  private receive(raw: string): RoomClientOutcome {
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return {
        kind: "problem",
        problem: {
          fatal: true,
          message: "The Room sent invalid data. Rejoin from the Versus page.",
        },
      };
    }
    const message = parseServerMsg(decoded);
    if (!message) {
      return {
        kind: "problem",
        problem: {
          fatal: true,
          message: "The Room sent malformed data. Rejoin from the Versus page.",
        },
      };
    }
    if (message.t === "error") {
      return {
        kind: "problem",
        problem: { fatal: message.fatal === true, message: message.msg },
      };
    }

    const snapshot = message.room;
    let result: SimResult | null;
    let view: RoomView;
    try {
      result =
        snapshot.field && snapshot.simSeed != null
          ? simulateTournament(snapshot.field, snapshot.simSeed)
          : null;
      view = deriveRoomView(snapshot, this.playerId, result);
    } catch {
      return {
        kind: "problem",
        problem: {
          fatal: true,
          message: "The Room sent data this client could not process. Rejoin from the Versus page.",
        },
      };
    }
    this.session = { code: this.code, playerId: this.playerId, snapshot, result, view };
    this.reconcile();
    return { kind: "session", session: this.session };
  }

  private send(message: ClientMsg) {
    this.adapters.sendRaw(JSON.stringify(message));
  }

  private reconcile() {
    const facts: ClientFacts = {
      snapshot: this.session?.snapshot ?? null,
      result: this.session?.result ?? null,
      playerId: this.playerId,
      code: this.code,
      opens: this.opens,
      phrasesKey: this.adapters.phrasesKey(),
    };
    const cues = roomCues(this.previousFacts, facts, this.adapters.now());
    this.previousFacts = facts;
    for (const cue of cues) {
      if (cue.kind === "stinger") this.adapters.showStinger();
      else if (cue.kind === "syncPhrases") this.send({ t: "phrases", phrases: cue.phrases });
      else if (!this.adapters.storage.getItem(cue.dedupeKey)) {
        this.adapters.storage.setItem(cue.dedupeKey, "1");
        this.adapters.recordRun(cue.record);
      }
    }
  }
}
