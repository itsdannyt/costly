import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { costly } from "../index.js";

// Mock fetch globally to capture batcher calls
let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Fake Anthropic-like client
function createFakeClient(response?: Record<string, unknown>) {
  const defaultResponse = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-sonnet-4-20250514",
    usage: { input_tokens: 100, output_tokens: 25 },
  };

  return {
    messages: {
      create: vi.fn().mockResolvedValue(response ?? defaultResponse),
      stream: vi.fn().mockReturnValue(createFakeStream()),
    },
  };
}

function createFakeStream() {
  const events = [
    { type: "message_start", message: { usage: { input_tokens: 150 } } },
    { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
    { type: "message_delta", usage: { output_tokens: 30 } },
  ];

  let index = 0;
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= events.length) return { done: true, value: undefined };
          return { done: false, value: events[index++] };
        },
      };
    },
    // Simulate the Anthropic stream's then() — it resolves with finalMessage
    then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
      // Simulate promise resolution with a response
      Promise.resolve({
        usage: { input_tokens: 150, output_tokens: 30 },
      }).then(resolve, reject);
    },
  };

  return stream;
}

describe("costly()", () => {
  it("throws if no apiKey is provided", () => {
    delete process.env.COSTLY_API_KEY;
    expect(() => costly()).toThrow("apiKey is required");
  });

  it("reads apiKey from env var", () => {
    process.env.COSTLY_API_KEY = "ck_env_test";
    const client = costly();
    expect(client).toBeDefined();
    expect(client.wrap).toBeInstanceOf(Function);
    delete process.env.COSTLY_API_KEY;
  });

  it("config apiKey takes precedence over env var", () => {
    process.env.COSTLY_API_KEY = "ck_env";
    const client = costly({ apiKey: "ck_config" });
    expect(client).toBeDefined();
    delete process.env.COSTLY_API_KEY;
  });
});

describe("wrap() — messages.create()", () => {
  it("proxies create() call and returns the response", async () => {
    const fake = createFakeClient();
    const wrapped = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
      flushBatchSize: 100,
    }).wrap(fake);

    const result = await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(result.content[0].text).toBe("Hello!");
    expect(fake.messages.create).toHaveBeenCalledOnce();
  });

  it("strips costly metadata before forwarding to the real SDK", async () => {
    const fake = createFakeClient();
    const wrapped = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
      flushBatchSize: 100,
    }).wrap(fake);

    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      costly: { tag: "chatbot", userId: "user_123" },
    });

    // The call to the real SDK should NOT have the costly property
    const calledWith = fake.messages.create.mock.calls[0][0];
    expect(calledWith).not.toHaveProperty("costly");
    expect(calledWith.model).toBe("claude-sonnet-4-20250514");
  });

  it("logs request data to the batcher and sends on flush", async () => {
    const fake = createFakeClient();
    const c = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
      flushBatchSize: 100,
    });
    const wrapped = c.wrap(fake);

    await wrapped.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
      costly: { tag: "chatbot", userId: "user_123" },
    });

    // Wait a tick for the .then() handler to fire
    await new Promise((r) => setTimeout(r, 10));
    await c.flush();

    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body.logs).toHaveLength(1);

    const log = body.logs[0];
    expect(log.model).toBe("claude-sonnet-4-20250514");
    expect(log.tag).toBe("chatbot");
    expect(log.userId).toBe("user_123");
    expect(log.inputTokens).toBe(100);
    expect(log.outputTokens).toBe(25);
    expect(log.status).toBe("success");
    expect(log.totalCost).toBeGreaterThan(0);
    expect(log.maxTokens).toBe(1024);
    expect(log.promptHash).toBeTruthy();
    expect(log.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs errors without crashing the caller", async () => {
    const error = new Error("rate_limit_error");
    (error as Record<string, unknown>).error = { type: "rate_limit_error" };

    const fake = createFakeClient();
    fake.messages.create.mockRejectedValue(error);

    const c = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
      flushBatchSize: 100,
    });
    const wrapped = c.wrap(fake);

    await expect(
      wrapped.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toThrow("rate_limit_error");

    await new Promise((r) => setTimeout(r, 10));
    await c.flush();

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    const log = body.logs[0];
    expect(log.status).toBe("error");
    expect(log.errorType).toBe("rate_limit_error");
  });
});

describe("wrap() — messages.stream()", () => {
  it("wraps stream and captures token usage", async () => {
    const fake = createFakeClient();
    const c = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
      flushBatchSize: 100,
    });
    const wrapped = c.wrap(fake);

    const stream = wrapped.messages.stream({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Hello" }],
    });

    // Consume the async iterator
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);

    // Wait for the promise .then() handler + stream done log
    await new Promise((r) => setTimeout(r, 10));
    await c.flush();

    expect(fetchSpy).toHaveBeenCalled();
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    // May have 1-2 logs (stream done + promise resolve)
    const streamLog = body.logs.find(
      (l: Record<string, unknown>) => l.inputTokens === 150,
    );
    expect(streamLog).toBeTruthy();
    expect(streamLog.outputTokens).toBe(30);
    expect(streamLog.status).toBe("success");
  });
});

describe("wrap() — property passthrough", () => {
  it("passes through non-intercepted properties", () => {
    const fake = {
      apiKey: "sk-test",
      baseURL: "https://api.anthropic.com",
      messages: {
        create: vi.fn().mockResolvedValue({}),
      },
    };

    const wrapped = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
    }).wrap(fake);

    expect(wrapped.apiKey).toBe("sk-test");
    expect(wrapped.baseURL).toBe("https://api.anthropic.com");
  });

  it("returns same proxy for same nested object", () => {
    const fake = createFakeClient();
    const wrapped = costly({
      apiKey: "ck_test",
      endpoint: "https://test.local/ingest",
    }).wrap(fake);

    // Accessing .messages twice should return the same proxy
    expect(wrapped.messages).toBe(wrapped.messages);
  });
});
