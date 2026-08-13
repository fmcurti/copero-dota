import { afterEach, describe, expect, it, vi } from "vitest";
import { sendAuthOtp } from "./email";

describe("auth OTP email adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires delivery configuration", async () => {
    await expect(sendAuthOtp({}, { email: "a@example.com", otp: "123456" })).rejects.toThrow(
      "not configured",
    );
  });

  it("sends a five-minute code through Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await sendAuthOtp(
      { RESEND_API_KEY: "secret", AUTH_EMAIL_FROM: "Copero <auth@example.com>" },
      { email: "drafter@example.com", otp: "654321" },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: "Copero <auth@example.com>",
      to: ["drafter@example.com"],
      subject: "654321 is your El Copero sign-in code",
    });
  });

  it("surfaces delivery failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("bad sender", { status: 422 })),
    );
    await expect(
      sendAuthOtp(
        { RESEND_API_KEY: "secret", AUTH_EMAIL_FROM: "auth@example.com" },
        { email: "a@example.com", otp: "123456" },
      ),
    ).rejects.toThrow("422 bad sender");
  });
});
