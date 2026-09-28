# Contributing

Thanks for your interest! Issues and pull requests are welcome.

## Setup

```bash
bun install
bun run dev          # server :3001 + Vite :5173 (set your EODHD key in Settings)
```

To work on the UI without spending API credits, set `EODVIEW_UNIVERSE=off` to pause the screener pipeline.

## Before opening a PR

```bash
bun run typecheck
bun test
(cd client && bun run build)
```

CI runs the same checks.

## Conventions

- The client/server contract lives in `shared/src/types.ts`; change it deliberately and update both sides.
- Pure logic (indicators, metrics, SQL building, parsers, UI helpers) goes in its own module with `*.test.ts` next to
  it. Tests must not call EODHD. Use a fake `fetch` or the trimmed fixtures in `__fixtures__/` and `fixtures/`.
- Strict TypeScript, Bun APIs on the server (no Express), React function components and Zustand on the client.
- Never commit keys, tokens, `.env*` files, `server/data/` or Terraform state.

## Project map

See [docs/CONFIGURATION.md](docs/CONFIGURATION.md#architecture) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
