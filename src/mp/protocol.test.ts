import { describe, expect, it } from "vitest";
import { NAME_MAX, hasYouTag, parseClientMsg, sanitizeName } from "./protocol";

describe("team name sanitising", () => {
  it("leaves ordinary names alone", () => {
    expect(sanitizeName("El Copero")).toBe("El Copero");
    expect(hasYouTag("El Copero")).toBe(false);
  });

  it("trims and collapses whitespace", () => {
    expect(sanitizeName("  La   Grieta  ")).toBe("La Grieta");
  });

  it("caps length", () => {
    expect(sanitizeName("x".repeat(80))).toHaveLength(NAME_MAX);
  });

  it("rejects the (you) marker in any casing or padding", () => {
    for (const raw of ["(you)", "(YOU)", "(You)", "( you )", "Chan (you)", "a(YoU)b"]) {
      expect(hasYouTag(raw)).toBe(true);
    }
  });

  it("does not flag names that merely contain the word you", () => {
    for (const raw of ["you", "Yousuf", "(your team)", "you)", "(you"]) {
      expect(hasYouTag(raw)).toBe(false);
    }
  });

  it("strips the marker rather than keeping a fake self-label", () => {
    expect(sanitizeName("Chan (you)")).toBe("Chan");
    expect(sanitizeName("(you) Chan")).toBe("Chan");
    expect(sanitizeName("Pichula (YOU) FC")).toBe("Pichula FC");
  });

  it("collapses to empty when the name was only the marker", () => {
    expect(sanitizeName("(you)")).toBe("");
    expect(sanitizeName("  ( You ) ")).toBe("");
  });

  it("is idempotent", () => {
    const once = sanitizeName("Chan (you) (you)");
    expect(sanitizeName(once)).toBe(once);
  });
});

describe("client message parsing", () => {
  it("accepts and normalizes every message family", () => {
    expect(parseClientMsg({ t: "configure", config: { timerSecs: 25, visibility: "public", ignored: true } })).toEqual({
      t: "configure",
      config: { timerSecs: 25, visibility: "public" },
    });
    expect(parseClientMsg({ t: "configure", config: { draftMode: "turbo" } })).toEqual({
      t: "configure",
      config: { draftMode: "turbo" },
    });
    expect(parseClientMsg({ t: "rename", name: "Chan" })).toEqual({ t: "rename", name: "Chan" });
    expect(parseClientMsg({ t: "phrases", phrases: ["gg", "ez"] })).toEqual({
      t: "phrases",
      phrases: ["gg", "ez"],
    });
    for (const t of ["spectate", "takeSeat", "start", "play"] as const) {
      expect(parseClientMsg({ t })).toEqual({ t });
    }
    expect(parseClientMsg({ t: "kick", playerId: "p2" })).toEqual({ t: "kick", playerId: "p2" });
    expect(
      parseClientMsg({
        t: "draft",
        action: { type: "pick", card: { kind: "player", steamId: 123 } },
      }),
    ).toEqual({ t: "draft", action: { type: "pick", card: { kind: "player", steamId: 123 } } });
    expect(parseClientMsg({ t: "draft", action: { type: "mulligan" } })).toEqual({
      t: "draft",
      action: { type: "mulligan" },
    });
    expect(parseClientMsg({ t: "assignHero", steamId: 123, heroId: 456 })).toEqual({
      t: "assignHero",
      steamId: 123,
      heroId: 456,
    });
    expect(parseClientMsg({ t: "beat", action: "skip" })).toEqual({ t: "beat", action: "skip" });
  });

  it("rejects malformed and unknown payloads", () => {
    for (const value of [
      null,
      [],
      {},
      { t: "wat" },
      { t: "rename", name: 42 },
      { t: "phrases", phrases: ["gg", 42] },
      { t: "configure", config: { timerSecs: 10 } },
      { t: "configure", config: { draftMode: "hyper" } },
      { t: "draft", action: { type: "pick" } },
      { t: "draft", action: { type: "deny", card: { kind: "hero", heroId: -1 } } },
      { t: "assignHero", steamId: 1, heroId: 1.5 },
      { t: "beat", action: "rewind" },
    ]) {
      expect(parseClientMsg(value)).toBeNull();
    }
  });
});
