import { describe, expect, it, vi } from "vitest";
import {
  accountNameFromIdToken,
  authCapabilities,
  handleDevOtp,
  MAX_AVATAR_CHARS,
  syncAccountName,
  userWritePatch,
  type AuthEnv,
} from "./auth";

const authDb = {} as D1Database;

/** An unsigned JWT with the given payload, base64url like a real ID token. */
function idToken(claims: Record<string, unknown>): string {
  const b64url = (s: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(s)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

describe("account name sync", () => {
  it("reads the name claim of an ID token, accents included", () => {
    expect(accountNameFromIdToken(idToken({ name: "  Ana   Pérez ", email: "a@b.c" }))).toBe(
      "Ana Pérez",
    );
  });

  it("returns null for tokens without a usable name", () => {
    expect(accountNameFromIdToken(idToken({ email: "a@b.c" }))).toBeNull();
    expect(accountNameFromIdToken(idToken({ name: "   " }))).toBeNull();
    expect(accountNameFromIdToken(idToken({ name: 7 }))).toBeNull();
    expect(accountNameFromIdToken("not.a-jwt")).toBeNull();
    expect(accountNameFromIdToken(undefined)).toBeNull();
    expect(accountNameFromIdToken(null)).toBeNull();
  });

  it("copies a Google account's ID-token name onto its user", async () => {
    const updateUser = vi.fn().mockResolvedValue({});
    await syncAccountName(
      { providerId: "google", userId: "u1", idToken: idToken({ name: "Ana Pérez" }) },
      updateUser,
    );
    expect(updateUser).toHaveBeenCalledWith("u1", { accountName: "Ana Pérez" });
  });

  it("leaves other providers and tokenless rows alone", async () => {
    const updateUser = vi.fn();
    await syncAccountName(
      { providerId: "credential", userId: "u1", idToken: idToken({ name: "x" }) },
      updateUser,
    );
    await syncAccountName({ providerId: "google", userId: "u1", idToken: null }, updateUser);
    await syncAccountName({ providerId: "google", userId: "u1" }, undefined);
    expect(updateUser).not.toHaveBeenCalled();
  });
});

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

    await expect(authCapabilities(env)).resolves.toEqual({
      google: true,
      emailOtp: true,
      password: true,
    });
    expect(resendGet).toHaveBeenCalledOnce();
  });

  it("still accepts local and per-Worker string secrets", async () => {
    await expect(
      authCapabilities({ AUTH_DB: authDb, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    ).resolves.toEqual({ google: true, emailOtp: false, password: true });
  });

  it("treats an unpopulated local Secrets Store as unavailable", async () => {
    const missing = { get: vi.fn().mockRejectedValue(new Error('Secret "RESEND_API_KEY" not found')) };
    await expect(
      authCapabilities({ AUTH_DB: authDb, RESEND_API_KEY_STORE: missing }),
    ).resolves.toEqual({ google: false, emailOtp: false, password: true });
  });

  it("keeps the dev inbox off outside localhost or once email is real", async () => {
    const request = (host: string) => new Request(`http://${host}/api/dev-otp?email=a@b.c`);
    const bare: AuthEnv = { AUTH_DB: authDb };

    const production = await handleDevOtp(request("dotero.fmcurti.com.ar"), bare);
    expect(production.status).toBe(404);

    const configured = await handleDevOtp(request("localhost"), {
      AUTH_DB: authDb,
      RESEND_API_KEY: "re_test",
      AUTH_EMAIL_FROM: "El Copero <auth@example.com>",
    });
    expect(configured.status).toBe(404);

    const local = await handleDevOtp(request("localhost"), bare);
    expect(local.status).toBe(200);
    await expect(local.json()).resolves.toEqual({ otp: null });
  });

  it("offers email codes on localhost and keeps password sign-in provider-independent", async () => {
    await expect(authCapabilities({ AUTH_DB: authDb }, "localhost")).resolves.toEqual({
      google: false,
      emailOtp: true,
      password: true,
    });
    await expect(authCapabilities({ AUTH_DB: authDb }, "dotero.fmcurti.com.ar")).resolves.toEqual({
      google: false,
      emailOtp: false,
      password: true,
    });
  });
});

describe("user write gate", () => {
  const avatar = (chars: number) => `data:image/jpeg;base64,${"A".repeat(chars)}`;

  it("sanitizes nicknames like room names", () => {
    expect(userWritePatch({ name: "  Rubick   (you) enjoyer  " }, "update")).toEqual({
      name: "Rubick enjoyer",
    });
    expect(userWritePatch({ name: "x".repeat(80) }, "update")).toEqual({ name: "x".repeat(30) });
  });

  it("rejects a nickname that sanitizes to nothing on update", () => {
    expect(() => userWritePatch({ name: " (you) " }, "update")).toThrowError(/empty/);
    expect(() => userWritePatch({ name: 322 }, "update")).toThrowError(/nickname/i);
  });

  it("falls back to the default name on create instead of failing sign-up", () => {
    expect(userWritePatch({ name: " (you) ", email: "a@b.c" }, "create")).toEqual({
      name: "Sin Nombre",
    });
  });

  it("leaves writes without profile fields alone", () => {
    expect(userWritePatch({ emailVerified: true }, "update")).toEqual({});
    expect(userWritePatch({ name: undefined, image: undefined }, "update")).toEqual({});
  });

  it("accepts OAuth https avatars, inline uploads, and image clearing", () => {
    expect(() =>
      userWritePatch({ image: "https://lh3.googleusercontent.com/a/pic=s96-c" }, "update"),
    ).not.toThrow();
    expect(() => userWritePatch({ image: avatar(4000) }, "update")).not.toThrow();
    expect(() => userWritePatch({ image: null }, "update")).not.toThrow();
  });

  it("rejects oversized, non-image, or non-https avatars", () => {
    expect(() => userWritePatch({ image: avatar(MAX_AVATAR_CHARS) }, "update")).toThrowError(
      /small image/,
    );
    expect(() => userWritePatch({ image: "http://evil.example/pic.png" }, "update")).toThrow();
    expect(() => userWritePatch({ image: "data:text/html;base64,PGI+" }, "update")).toThrow();
    expect(() => userWritePatch({ image: `https://x.example/${"a".repeat(700)}` }, "update")).toThrow();
    expect(() => userWritePatch({ image: 7 }, "update")).toThrow();
  });
});
