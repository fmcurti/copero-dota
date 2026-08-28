import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { handleRankedApi } from "./rankedApi";

const partyserver = vi.hoisted(() => ({ getServerByName: vi.fn() }));
const auth = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("partyserver", () => partyserver);
vi.mock("./auth", () => auth);

/** A D1 stand-in: every prepared statement resolves to the given rows, in order. */
function fakeDb(...resultSets: unknown[][]): Env["AUTH_DB"] {
  const statements = resultSets.map((results) => {
    const stmt = { bind: () => stmt, all: async () => ({ results }) };
    return stmt;
  });
  let next = 0;
  return {
    prepare: () => statements[next++],
    batch: async (stmts: { all: () => Promise<{ results: unknown[] }> }[]) =>
      Promise.all(stmts.map((s) => s.all())),
  } as unknown as Env["AUTH_DB"];
}

// The ladder query's raw rows: a Google player and a password player.
const googlePlayer = {
  userId: "u1",
  name: "Rubick enjoyer",
  accountName: "Ana Pérez",
  email: "ana.perez@gmail.com",
  image: null,
  rating: 1042,
  gamesPlayed: 7,
};
const passwordPlayer = {
  userId: "u2",
  name: "Sin Nombre",
  accountName: null,
  email: "tomas.g@example.com",
  image: null,
  rating: 998,
  gamesPlayed: 3,
};

const publicRow = ({ accountName: _a, email: _e, ...row }: typeof googlePlayer, account: string) => ({
  ...row,
  account,
});

describe("ranked hub API", () => {
  it("names the account behind each nickname without exposing full emails", async () => {
    auth.getUser.mockResolvedValue(null);
    const env = { AUTH_DB: fakeDb([googlePlayer, passwordPlayer]) } as Env;

    const response = await handleRankedApi(
      new Request("https://dotero.fmcurti.com.ar/api/ranked/hub"),
      env,
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { leaderboard: unknown[]; me: unknown };
    expect(body.leaderboard).toEqual([
      publicRow(googlePlayer, "Ana Pérez"),
      publicRow(passwordPlayer, "tomas.g"),
    ]);
    expect(JSON.stringify(body)).not.toContain("@");
    expect(body.me).toBeNull();
  });

  it("resolves the ladder the same way for signed-in viewers", async () => {
    auth.getUser.mockResolvedValue({ id: "u1", name: "Rubick enjoyer", email: googlePlayer.email });
    const me = { rating: 1042, gamesPlayed: 7, rank: 1 };
    const env = { AUTH_DB: fakeDb([googlePlayer], [me], []) } as Env;

    const response = await handleRankedApi(
      new Request("https://dotero.fmcurti.com.ar/api/ranked/hub"),
      env,
    );

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as { leaderboard: unknown[]; me: unknown };
    expect(body.leaderboard).toEqual([publicRow(googlePlayer, "Ana Pérez")]);
    expect(body.me).toEqual(me);
  });
});

describe("ranked queue status API", () => {
  it("reads the global queue without authentication or joining it", async () => {
    const deadline = Date.now() + 10_000;
    const getQueueStatus = vi.fn().mockResolvedValue({ count: 3, deadline });
    partyserver.getServerByName.mockResolvedValue({ getQueueStatus });
    const queueBinding = {} as Env["CoperoRankedQueue"];
    const env = { CoperoRankedQueue: queueBinding } as Env;

    const response = await handleRankedApi(
      new Request("https://dotero.fmcurti.com.ar/api/ranked/queue-status"),
      env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toEqual({ count: 3, deadline });
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(partyserver.getServerByName).toHaveBeenCalledWith(queueBinding, "main");
    expect(getQueueStatus).toHaveBeenCalledOnce();
  });
});
