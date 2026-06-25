import { describe, it, expect } from "vitest";
import {
  generateMemberId,
  generateUniqueMemberId,
  isValidMemberId,
  normalizeMemberId,
  formatMemberId,
  ambiguousChars,
  LETTERS,
  DIGITS,
} from "./ids";

describe("Member ID generation (§7)", () => {
  it("is 8 chars, alternating letter/digit, valid format", () => {
    for (let i = 0; i < 500; i++) {
      const id = generateMemberId();
      expect(id).toHaveLength(8);
      expect(isValidMemberId(id)).toBe(true);
    }
  });

  it("uses the ambiguity-free alphabet (no I/O/0/1)", () => {
    const joined = (LETTERS + DIGITS).split("");
    expect(joined).not.toContain("I");
    expect(joined).not.toContain("O");
    expect(joined).not.toContain("0");
    expect(joined).not.toContain("1");
    for (let i = 0; i < 200; i++) {
      expect(generateMemberId()).not.toMatch(/[IO01]/);
    }
  });

  it("generates unique IDs avoiding collisions", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const id = generateUniqueMemberId(taken);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(2000);
  });
});

describe("Member ID validation & formatting", () => {
  it("rejects wrong length and bad alphabet", () => {
    expect(isValidMemberId("B7K2M9X")).toBe(false); // 7 chars
    expect(isValidMemberId("B7K2M9X4Z")).toBe(false); // 9 chars
    expect(isValidMemberId("BBK2M9X4")).toBe(false); // letter where digit expected
    expect(isValidMemberId("I7K2M9X4")).toBe(false); // ambiguous I
  });
  it("accepts a canonical id", () => {
    expect(isValidMemberId("B7K2M9X4")).toBe(true);
  });
  it("normalizes case and separators", () => {
    expect(normalizeMemberId("b7k2-m9x4")).toBe("B7K2M9X4");
    expect(normalizeMemberId("B7K2 · M9X4")).toBe("B7K2M9X4");
  });
  it("formats for display", () => {
    expect(formatMemberId("B7K2M9X4")).toBe("B7K2-M9X4");
  });
  it("flags ambiguous chars without auto-fixing (Q27)", () => {
    expect(ambiguousChars("BoK2M9X4")).toEqual(["O"]);
  });
});
