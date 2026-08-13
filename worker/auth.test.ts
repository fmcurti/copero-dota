import { describe, expect, it, vi } from "vitest";
import { authCapabilities, type AuthEnv } from "./auth";

const authDb = {} as D1Database;

describe("auth environment", () => {
  it("reads account-level Secrets Store bindings", async () => {
    const resendGet = vi.fn().mockResolvedValue("re_test");
    const env: AuthEnv = {
      AUTH_DB: authDb,
      GOOGLE_CLIENT_ID_STORE: { get: vi.fn().mockResolvedValue("google-id") },
      GOOGLE_CLIENT_SECRET_STORE: { get: vi.fn().mockResolvedValue("google-secret") },
      RESEND_API_KEY_STORE: { get: resendGet },
      AUTH_EMAIL_FROM: "El Copero <auth@example.com>",
    };

    await expect(authCapabilities(env)).resolves.toEqual({ google: true, emailOtp: true });
    expect(resendGet).toHaveBeenCalledOnce();
  });

  it("still accepts local and per-Worker string secrets", async () => {
    await expect(
      authCapabilities({ AUTH_DB: authDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    ).resolves.toEqual({ google: true, emailOtp: false });
  });

  it("treats an unpopulated local Secrets Store as unavailable", async () => {
    const missing = { get: vi.fn().mockRejectedValue(new Error('Secret "RESEND_API_KEY" not found')) };
    await expect(
      authCapabilities({ AUTH_DB: authDb, RESEND_API_KEY_STORE: missing }),
    ).resolves.toEqual({ google: false, emailOtp: false });
  });
});
