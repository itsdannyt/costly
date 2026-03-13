# Contributing to Costly

Thanks for your interest in contributing to Costly!

## Guidelines

- **SDK only** — This repo contains the open-source SDK. The dashboard is closed-source.
- **Keep it lean** — The SDK should stay under 300 lines of core code. Zero runtime dependencies (only `@anthropic-ai/sdk` as a peer dependency).
- **Zero latency impact** — All logging must be async and fire-and-forget. Never block or slow down the user's API calls.
- **Don't break the proxy** — The wrapped client must behave identically to a raw Anthropic client for all SDK methods.

## Development

```bash
# Install dependencies
pnpm install

# Run tests
pnpm test

# Build
pnpm build
```

## Requirements

- Node.js 18+
- pnpm 10+

## Submitting Changes

1. Fork the repo
2. Create a feature branch (`git checkout -b my-feature`)
3. Make your changes
4. Run tests (`pnpm test`)
5. Submit a pull request

## Reporting Issues

Please open an issue on GitHub with:
- What you expected to happen
- What actually happened
- Steps to reproduce
- Your Node.js version and OS
