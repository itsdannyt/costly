# Costly

**Your AI is Costly. Let's fix that.**

Costly is an open-source cost monitoring SDK for developers building with the Anthropic Claude API. It wraps your existing Anthropic client, monitors usage patterns, and surfaces exactly where you're overspending — with actionable fixes.

## Quick Start

```bash
npx costly init
```

The CLI installs the SDK, detects your Anthropic usage, wraps your client, and connects to your dashboard. That's it.

## How It Works

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { costly } from "costly";

// Wrap your Anthropic client — two lines
const client = costly({
  apiKey: "ck_your_project_key",
}).wrap(new Anthropic());

// Use it exactly as before
const msg = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello" }],

  // Optional: tag by feature for per-feature cost tracking
  costly: { tag: "chatbot", userId: "user_123" },
});
```

- **Zero latency** — Logs are batched and sent asynchronously. Your API calls go directly to Anthropic.
- **Zero config** — `npx costly init` handles everything.
- **7 waste detectors** — Prompt bloat, model overkill, duplicate queries, runaway features, error waste, output overgeneration, and cost trajectory warnings.

## 7 Waste Detectors

| Detector | What it finds | Typical savings |
|---|---|---|
| Prompt Bloat | Repeated system prompts across calls | Up to 90% on input costs |
| Model Overkill | Expensive models on simple tasks | 73% switching Opus to Haiku |
| Duplicate Queries | Identical prompts sent multiple times | 100% on duplicates |
| Runaway Features | One feature eating >60% of budget | Varies |
| Error Waste | Failed calls still billing input tokens | 100% on errors |
| Output Overgeneration | max_tokens set far above actual output | Varies |
| Cost Trajectory | Spend growing faster than usage | Early warning |

## Dashboard

Your dashboard at [getcostly.dev](https://getcostly.dev) shows:

- Real-time cost overview (today's spend, avg cost/call, error rate)
- 14-day cost trend chart
- 30/60/90 day bill forecast
- Per-feature cost breakdown (by tag)
- Per-model cost breakdown
- Waste audit findings with severity and fix recommendations

## SDK Options

```typescript
costly({
  apiKey: "ck_...",          // Required: your project API key
  endpoint: "...",           // Optional: custom ingest endpoint
  batchSize: 10,             // Optional: logs per batch (default 10)
  flushInterval: 5000,       // Optional: ms between flushes (default 5000)
});
```

## Per-Call Tagging

```typescript
await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [...],
  costly: {
    tag: "summarizer",     // Feature name for cost breakdown
    userId: "user_456",    // Optional: per-user tracking
  },
});
```

## SDK Architecture

```
src/
├── index.ts       # Anthropic client wrapper (deep proxy)
├── batcher.ts     # Async log batching with fire-and-forget
├── pricing.ts     # Per-model cost calculation
├── hash.ts        # Prompt deduplication hashing
├── callsite.ts    # Auto-tagging via stack trace
├── cli.ts         # npx costly init
├── types.ts       # TypeScript interfaces
└── __tests__/     # Test suite (vitest)
```

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT — see [LICENSE](LICENSE) for details.

---

Built by [Danny](https://x.com/getcostly) in Scottsdale, AZ.
