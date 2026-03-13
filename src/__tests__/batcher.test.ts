import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LogBatcher } from "../batcher.js";
import type { RequestLog } from "../types.js";

function makeFakeLog(overrides?: Partial<RequestLog>): RequestLog {
  return {
    projectId: "test-project",
    timestamp: new Date().toISOString(),
    model: "claude-sonnet-4-20250514",
    tag: null,
    userId: null,
    inputTokens: 100,
    outputTokens: 50,
    totalCost: 0.001,
    maxTokens: 1024,
    status: "success",
    errorType: null,
    promptHash: "abc123",
    systemPromptHash: null,
    callSite: "test.ts:10",
    durationMs: 200,
    ...overrides,
  };
}

describe("LogBatcher", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batches logs and flushes when batch size is reached", async () => {
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 3,
      debug: false,
    });

    batcher.add(makeFakeLog());
    batcher.add(makeFakeLog());
    expect(fetchSpy).not.toHaveBeenCalled();

    batcher.add(makeFakeLog()); // hits batch size
    // flush is sync (fires fetch), wait for the send promise
    await batcher.flushAsync();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(3);
  });

  it("sends correct auth header", async () => {
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_my_secret_key",
      flushInterval: 60_000,
      flushBatchSize: 1,
      debug: false,
    });

    batcher.add(makeFakeLog());
    await batcher.flushAsync();

    const headers = fetchSpy.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer ck_my_secret_key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("flushAsync sends remaining logs", async () => {
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 100,
      debug: false,
    });

    batcher.add(makeFakeLog());
    batcher.add(makeFakeLog());

    await batcher.flushAsync();
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(2);
  });

  it("does not crash when fetch fails and debug is off", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 1,
      debug: false,
    });

    batcher.add(makeFakeLog());
    await batcher.flushAsync(); // should not throw
  });

  it("logs warning when fetch fails and debug is on", async () => {
    fetchSpy.mockRejectedValue(new Error("network error"));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 1,
      debug: true,
    });

    batcher.add(makeFakeLog());
    await batcher.flushAsync();

    expect(warnSpy).toHaveBeenCalledWith(
      "[costly] Failed to send logs:",
      "network error",
    );
  });

  it("shutdown flushes and cleans up", async () => {
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 100,
      debug: false,
    });

    batcher.add(makeFakeLog());
    await batcher.shutdown();

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does not send when queue is empty", async () => {
    const batcher = new LogBatcher({
      endpoint: "https://example.com/ingest",
      apiKey: "ck_test",
      flushInterval: 60_000,
      flushBatchSize: 10,
      debug: false,
    });

    await batcher.flushAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
