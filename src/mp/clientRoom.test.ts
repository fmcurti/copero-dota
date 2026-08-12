import { describe, expect, it } from "vitest";
import { RoomClientHost, type RoomClientAdapters } from "./clientRoom";
import { DEFAULT_MP_CONFIG, type RoomSnapshot } from "./protocol";

function snapshot(phase: RoomSnapshot["phase"] = "lobby"): RoomSnapshot {
  return {
    phase,
    config: DEFAULT_MP_CONFIG,
    seats: [{ playerId: "p1", name: "Alpha", connected: true, isHost: true }],
    draft: null,
    strengths: null,
    heroAssignments: null,
    field: null,
    simSeed: null,
    beat: null,
  };
}

function harness() {
  const stored = new Map<string, string>();
  const sent: string[] = [];
  const records: unknown[] = [];
  let stingers = 0;
  let phrases = "gg\nez";
  const adapters: RoomClientAdapters = {
    sendRaw: (frame) => sent.push(frame),
    storage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
    recordRun: (record) => records.push(record),
    showStinger: () => stingers++,
    phrasesKey: () => phrases,
    now: () => 123,
  };
  const host = new RoomClientHost("ABCDE", "p1", adapters);
  return {
    host,
    stored,
    sent,
    records,
    stingers: () => stingers,
    setPhrases: (value: string) => (phrases = value),
  };
}

describe("Room client host", () => {
  it("owns spectator arrival, seat changes, and wire encoding", () => {
    const h = harness();
    expect(h.host.dispatch({ type: "connect", preferSpectator: true })).toEqual({
      kind: "query",
      spectator: true,
    });
    expect(h.stored.get("copero-mp-spectator:ABCDE")).toBe("1");

    h.host.dispatch({ type: "takeSeat" });
    expect(h.stored.has("copero-mp-spectator:ABCDE")).toBe(false);
    expect(JSON.parse(h.sent.at(-1)!)).toEqual({ t: "takeSeat" });

    h.host.dispatch({ type: "spectate" });
    expect(h.stored.get("copero-mp-spectator:ABCDE")).toBe("1");
    expect(JSON.parse(h.sent.at(-1)!)).toEqual({ t: "spectate" });
  });

  it("turns a Snapshot frame into the player's Room session", () => {
    const h = harness();
    h.host.dispatch({ type: "open" });
    const outcome = h.host.dispatch({
      type: "frame",
      raw: JSON.stringify({ t: "snapshot", room: snapshot() }),
    });
    expect(outcome).toMatchObject({
      kind: "session",
      session: { playerId: "p1", result: null, view: { mySeat: 0, isHost: true } },
    });
    expect(h.sent.map((frame) => JSON.parse(frame))).toContainEqual({
      t: "phrases",
      phrases: ["gg", "ez"],
    });
  });

  it("re-syncs phrases on reconnect and phrase edits", () => {
    const h = harness();
    h.host.dispatch({
      type: "frame",
      raw: JSON.stringify({ t: "snapshot", room: snapshot() }),
    });
    h.sent.length = 0;

    h.host.dispatch({ type: "open" });
    expect(JSON.parse(h.sent.at(-1)!)).toEqual({ t: "phrases", phrases: ["gg", "ez"] });

    h.setPhrases("una más");
    h.host.dispatch({ type: "phrasesChanged" });
    expect(JSON.parse(h.sent.at(-1)!)).toEqual({ t: "phrases", phrases: ["una más"] });
  });

  it("round-trips the optional chat log and rejects a malformed one", () => {
    const h = harness();
    const chat = [{ seq: 1, playerId: "p1", name: "Alpha", text: "hola", at: 100 }];
    expect(
      h.host.dispatch({
        type: "frame",
        raw: JSON.stringify({ t: "snapshot", room: { ...snapshot(), chat } }),
      }),
    ).toMatchObject({ kind: "session", session: { snapshot: { chat } } });
    expect(
      h.host.dispatch({
        type: "frame",
        raw: JSON.stringify({ t: "snapshot", room: { ...snapshot(), chat: [{ seq: 1 }] } }),
      }),
    ).toMatchObject({ kind: "problem", problem: { fatal: true } });
  });

  it("executes the lobby-to-Draft stinger cue", () => {
    const h = harness();
    h.host.dispatch({
      type: "frame",
      raw: JSON.stringify({ t: "snapshot", room: snapshot("lobby") }),
    });
    h.host.dispatch({
      type: "frame",
      raw: JSON.stringify({ t: "snapshot", room: snapshot("drafting") }),
    });
    expect(h.stingers()).toBe(1);
  });

  it("contains malformed frames and preserves server error severity", () => {
    const h = harness();
    expect(h.host.dispatch({ type: "frame", raw: "{" })).toMatchObject({
      kind: "problem",
      problem: { fatal: true },
    });
    expect(h.host.dispatch({ type: "frame", raw: JSON.stringify({ t: "wat" }) })).toMatchObject({
      kind: "problem",
      problem: { fatal: true },
    });
    expect(
      h.host.dispatch({
        type: "frame",
        raw: JSON.stringify({ t: "snapshot", room: { ...snapshot(), field: [{}] } }),
      }),
    ).toMatchObject({ kind: "problem", problem: { fatal: true } });
    expect(
      h.host.dispatch({
        type: "frame",
        raw: JSON.stringify({ t: "error", code: "bad-pick", msg: "Nope." }),
      }),
    ).toEqual({ kind: "problem", problem: { fatal: false, message: "Nope." } });
  });
});
