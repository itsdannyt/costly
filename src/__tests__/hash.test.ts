import { describe, it, expect } from "vitest";
import { hashString } from "../hash.js";

describe("hashString", () => {
  it("returns a base-36 string", () => {
    const result = hashString("hello world");
    expect(result).toMatch(/^[0-9a-z]+$/);
  });

  it("returns consistent results for the same input", () => {
    expect(hashString("test")).toBe(hashString("test"));
  });

  it("returns different results for different inputs", () => {
    expect(hashString("foo")).not.toBe(hashString("bar"));
  });

  it("handles empty string", () => {
    const result = hashString("");
    expect(result).toMatch(/^[0-9a-z]+$/);
  });

  it("handles long strings", () => {
    const long = "a".repeat(10_000);
    const result = hashString(long);
    expect(result).toMatch(/^[0-9a-z]+$/);
  });
});
