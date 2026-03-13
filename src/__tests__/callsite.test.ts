import { describe, it, expect } from "vitest";
import { getCallSite } from "../callsite.js";

describe("getCallSite", () => {
  it("returns a file:line string", () => {
    const site = getCallSite();
    expect(site).toMatch(/\.\w+:\d+$/); // .ts or .js depending on runtime
  });

  it("does not include costly internals in the result", () => {
    const site = getCallSite();
    expect(site).not.toContain("callsite.");
    expect(site).not.toContain("batcher.");
    expect(site).not.toContain("costlyWrappedMethod");
  });
});
