import { describe, expect, it } from "vitest";
import { NAME_MAX, hasYouTag, sanitizeName } from "./protocol";

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
