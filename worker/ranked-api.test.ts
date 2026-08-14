import { describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { handleRankedApi } from "./rankedApi";

const partyserver = vi.hoisted(() => ({ getServerByName: vi.fn() }));

vi.mock("partyserver", () => partyserver);

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
