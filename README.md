# sc-workorders-mcp

A local, read-only [MCP](https://modelcontextprotocol.io) server that lets an LLM query ServiceChannel work orders, locations, trades, provider assignments, and invoice status through typed tool calls instead of constructing raw API requests itself.

Five tools: `search_work_orders`, `get_work_order`, `get_work_order_notes`, `search_locations`, `search_trades`. All read-only — no writes, no mutations.

For everything else — how it works end to end, the auth model, ServiceChannel API quirks discovered along the way, design decisions, and how to rebuild it from scratch — see **[ARCHITECTURE.md](./ARCHITECTURE.md)**. For what's shipped, planned, proposed, or rejected — see **[BACKLOG.md](./BACKLOG.md)**.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in your ServiceChannel sandbox credentials
npm run build
npm start
```

Required environment variables (see `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `SC_CLIENT_ID` | yes | Must be registered **in the target environment itself** — a client synced from another environment won't authenticate. See ARCHITECTURE.md's auth quirks. |
| `SC_CLIENT_SECRET` | yes | |
| `SC_USERNAME` | yes | |
| `SC_PASSWORD` | yes | |
| `SC_TOKEN_URL` | no | Defaults to ServiceChannel's Sandbox2 login host |
| `SC_API_BASE_URL` | no | Defaults to ServiceChannel's Sandbox2 API host |

## Wiring into an MCP client

```bash
claude mcp add sc-workorders -s user \
  -e SC_CLIENT_ID=... -e SC_CLIENT_SECRET=... -e SC_USERNAME=... -e SC_PASSWORD=... \
  -- node /absolute/path/to/dist/src/index.js
```

## Testing

`npm test` runs a live smoke test (`test.ts`) directly against a real ServiceChannel sandbox — no mocking. This means it **requires real credentials and live sandbox data to pass**, and is not runnable in CI. `npm run test:unit` covers the pure logic (filter builders, response mappers) with no credentials needed — this is the one CI runs, alongside `npm run lint` and `npm run format:check`. See ARCHITECTURE.md's Testing section for exactly what each one checks.

## Status

Working prototype, not a production integration. See ARCHITECTURE.md's "Explicitly out of scope" section for what this deliberately does not do.
