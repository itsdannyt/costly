import type { CostlyConfig, CostlyCallMetadata, RequestLog } from "./types.js";
import { LogBatcher } from "./batcher.js";
import { calculateCost } from "./pricing.js";
import { hashString } from "./hash.js";
import { getCallSite } from "./callsite.js";

export type { CostlyConfig, CostlyCallMetadata, RequestLog };

const DEFAULT_ENDPOINT = "https://www.getcostly.dev/api/v1/ingest";
const DEFAULT_FLUSH_INTERVAL = 5000; // 5 seconds
const DEFAULT_FLUSH_BATCH_SIZE = 10;

// Methods to intercept on the Anthropic SDK
const INTERCEPTED_METHODS = new Set(["create", "stream"]);

interface CostlyClient {
  wrap<T extends object>(client: T): T;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function costly(config?: Partial<CostlyConfig>): CostlyClient {
  const apiKey = config?.apiKey ?? process.env.COSTLY_API_KEY;
  const projectId = config?.projectId ?? process.env.COSTLY_PROJECT_ID ?? "_";

  if (!apiKey) {
    throw new Error("[costly] apiKey is required — pass it in config or set COSTLY_API_KEY env var");
  }

  const batcher = new LogBatcher({
    endpoint: config?.endpoint ?? DEFAULT_ENDPOINT,
    apiKey,
    flushInterval: config?.flushInterval ?? DEFAULT_FLUSH_INTERVAL,
    flushBatchSize: config?.flushBatchSize ?? DEFAULT_FLUSH_BATCH_SIZE,
    debug: config?.debug ?? false,
  });

  return {
    wrap<T extends object>(client: T): T {
      return wrapClient(client, projectId, batcher);
    },
    flush() {
      return batcher.flushAsync();
    },
    shutdown() {
      return batcher.shutdown();
    },
  };
}

// Cache proxies to avoid creating a new one on every property access
const proxyCache = new WeakMap<object, object>();

function wrapClient<T extends object>(
  client: T,
  projectId: string,
  batcher: LogBatcher,
): T {
  const cached = proxyCache.get(client);
  if (cached) return cached as T;

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);

      // Wrap intercepted methods (create, stream)
      if (INTERCEPTED_METHODS.has(prop as string) && typeof value === "function") {
        return wrapMethod(value.bind(target), projectId, batcher);
      }

      // Recursively wrap nested objects (e.g., anthropic.messages)
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return wrapClient(value as object, projectId, batcher);
      }

      return value;
    },
  });

  proxyCache.set(client, proxy);
  return proxy as T;
}

function wrapMethod(
  originalMethod: (...args: unknown[]) => unknown,
  projectId: string,
  batcher: LogBatcher,
): (...args: unknown[]) => unknown {
  return function costlyWrappedMethod(...args: unknown[]): unknown {
    const callSite = getCallSite();
    const startTime = Date.now();

    // Extract and strip costly metadata from the request params
    const params = (args[0] ?? {}) as Record<string, unknown>;
    const costlyMeta = params.costly as CostlyCallMetadata | undefined;

    // Create a clean copy without the costly property
    if (costlyMeta) {
      const { costly: _, ...cleanParams } = params;
      args[0] = cleanParams;
    }

    // Extract data we need for logging before the call
    const model = (params.model as string) ?? "unknown";
    const maxTokens = (params.max_tokens as number) ?? null;
    const messages = params.messages as Array<{ role: string; content: unknown }> | undefined;
    const systemPrompt = params.system;

    // Build prompt hash from messages content
    const promptContent = messages
      ? JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })))
      : "";
    const promptHash = hashString(promptContent);
    const systemPromptHash = systemPrompt
      ? hashString(typeof systemPrompt === "string" ? systemPrompt : JSON.stringify(systemPrompt))
      : null;

    const tag = costlyMeta?.tag ?? null;
    const userId = costlyMeta?.userId ?? null;
    const autoCallSite = tag ? null : callSite;

    function buildLog(
      inputTokens: number,
      outputTokens: number,
      status: "success" | "error",
      errorType: string | null,
    ): RequestLog {
      return {
        projectId,
        timestamp: new Date().toISOString(),
        model,
        tag,
        userId,
        inputTokens,
        outputTokens,
        totalCost: calculateCost(model, inputTokens, outputTokens),
        maxTokens,
        status,
        errorType,
        promptHash,
        systemPromptHash,
        callSite: autoCallSite,
        durationMs: Date.now() - startTime,
      };
    }

    let result: unknown;
    try {
      result = originalMethod(...args);
    } catch (err) {
      // Synchronous error — log it but rethrow
      const error = err as { error?: { type?: string }; message?: string };
      batcher.add(buildLog(0, 0, "error", error.error?.type ?? error.message ?? "unknown_error"));
      throw err;
    }

    // Handle thenable results (Promises, Streams with .finalMessage(), etc.)
    if (result && typeof (result as { then?: unknown }).then === "function") {
      (result as Promise<unknown>).then(
        (response) => {
          try {
            const res = response as Record<string, unknown>;
            const usage = res.usage as { input_tokens?: number; output_tokens?: number } | undefined;
            batcher.add(buildLog(usage?.input_tokens ?? 0, usage?.output_tokens ?? 0, "success", null));
          } catch {
            // Never crash user code from logging
          }
        },
        (error) => {
          try {
            const err = error as { error?: { type?: string }; message?: string };
            batcher.add(buildLog(0, 0, "error", err.error?.type ?? err.message ?? "unknown_error"));
          } catch {
            // Never crash user code from logging
          }
        },
      );
    }

    // If result is a streaming object (has Symbol.asyncIterator), wrap it to capture usage
    if (result && typeof (result as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function") {
      return wrapStream(result as AsyncIterable<unknown>, buildLog, batcher);
    }

    return result;
  };
}

function wrapStream(
  stream: AsyncIterable<unknown>,
  buildLog: (input: number, output: number, status: "success" | "error", errorType: string | null) => RequestLog,
  batcher: LogBatcher,
): AsyncIterable<unknown> {
  const originalIterator = stream[Symbol.asyncIterator]();

  // Preserve all properties of the original stream object (e.g., .finalMessage(), .controller, etc.)
  const wrappedStream = Object.create(stream);

  wrappedStream[Symbol.asyncIterator] = () => {
    let inputTokens = 0;
    let outputTokens = 0;

    return {
      async next(): Promise<IteratorResult<unknown>> {
        try {
          const result = await originalIterator.next();

          if (result.done) {
            // Stream ended — log total usage
            batcher.add(buildLog(inputTokens, outputTokens, "success", null));
            return result;
          }

          // Accumulate usage from stream events
          const event = result.value as Record<string, unknown>;
          if (event.type === "message_delta") {
            const usage = event.usage as { output_tokens?: number } | undefined;
            if (usage?.output_tokens) {
              outputTokens = usage.output_tokens;
            }
          } else if (event.type === "message_start") {
            const message = event.message as { usage?: { input_tokens?: number } } | undefined;
            if (message?.usage?.input_tokens) {
              inputTokens = message.usage.input_tokens;
            }
          }

          return result;
        } catch (err) {
          const error = err as { error?: { type?: string }; message?: string };
          batcher.add(buildLog(inputTokens, outputTokens, "error", error.error?.type ?? error.message ?? "unknown_error"));
          throw err;
        }
      },
      async return(value?: unknown): Promise<IteratorResult<unknown>> {
        // Stream was cancelled early — still log what we have
        batcher.add(buildLog(inputTokens, outputTokens, "success", null));
        if (originalIterator.return) {
          return originalIterator.return(value);
        }
        return { done: true, value: undefined };
      },
    };
  };

  return wrappedStream;
}
