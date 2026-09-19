# sc-workorders-mcp

A local, read-only [MCP](https://modelcontextprotocol.io) server that lets an LLM query ServiceChannel work orders, locations, trades, provider assignments, and invoice status through typed tool calls instead of constructing raw API requests itself.

Eight tools: `search_work_orders`, `count_work_orders`, `get_work_order`, `get_work_order_notes`, `get_work_order_assets`, `get_work_order_activities`, `search_locations`, `search_trades`. All read-only — no writes, no mutations.

For everything else — how it works end to end, the auth model, ServiceChannel API quirks discovered along the way, design decisions, and how to rebuild it from scratch — see **[ARCHITECTURE.md](./ARCHITECTURE.md)**. For what's shipped, planned, proposed, or rejected — see **[BACKLOG.md](./BACKLOG.md)**.

## Quickstart

```bash
npm install
cp .env.example .env   # fill in your ServiceChannel sandbox credentials
npm run check-auth     # confirms your credentials work before you wire anything up
```

`npm start` runs the server directly (it speaks MCP over stdio, so you normally let your MCP client launch it instead — see below).

Required environment variables (see `.env.example`):

| Variable | Required | Notes |
|---|---|---|
| `SC_CLIENT_ID` | yes | Must be registered **in the target environment itself** — a client synced from another environment won't authenticate. See ARCHITECTURE.md's auth quirks. |
| `SC_CLIENT_SECRET` | yes | |
| `SC_USERNAME` | yes | |
| `SC_PASSWORD` | yes | |
| `SC_TOKEN_URL` | no | Defaults to ServiceChannel's Sandbox2 login host |
| `SC_API_BASE_URL` | no | Defaults to ServiceChannel's Sandbox2 API host |

## Getting credentials

You need four values, all created **in the same ServiceChannel environment you point the server at** (Sandbox2 by default):

- `SC_CLIENT_ID` / `SC_CLIENT_SECRET` — an OAuth "API Integration" created in that environment's own web UI. A client created in production, or synced over from it, does **not** work in the sandbox (the token call just redirects to a login page). See ARCHITECTURE.md's auth quirks.
- `SC_USERNAME` / `SC_PASSWORD` — a user account in that environment. Results are scoped to what that user can see.

Put them in `.env` (gitignored) and run `npm run check-auth`. It prints `OK: authenticated as <user> against <host>` on success. On failure the message says which pair to fix: a redirect (302) means the client ID/secret was rejected, a 400 means the username/password was.

## Changing credentials or users

The server reads its credentials once at startup, so a change needs a re-register and a restart:

1. Update `.env` and re-run `npm run check-auth` until it says `OK`.
2. `claude mcp remove sc-workorders`, then re-run the `claude mcp add` command below with the new values.
3. Restart your Claude session so the new server process starts.

This is also how you **log out** (`claude mcp remove sc-workorders`) and how you **switch users**. To use two identities side by side, register two entries with different names (e.g. `sc-workorders-alice` and `sc-workorders-bob`), each with its own `-e` values. There is no in-session login or user switching.

## Wiring into an MCP client

```bash
claude mcp add sc-workorders -s user \
  -e SC_CLIENT_ID=... -e SC_CLIENT_SECRET=... -e SC_USERNAME=... -e SC_PASSWORD=... \
  -- node /absolute/path/to/dist/src/index.js
```

`claude mcp add -e` stores those values in your local Claude config in plain text, and `.env` is only as private as your machine. Don't paste real values into issues, PRs, or screenshots, and rotate the client secret in ServiceChannel if one ever leaks.

## Testing

`npm test` runs a live smoke test (`test.ts`) directly against a real ServiceChannel sandbox — no mocking. This means it **requires real credentials and live sandbox data to pass**, and is not runnable in CI. `npm run test:unit` covers the pure logic (filter builders, response mappers) with no credentials needed — this is the one CI runs, alongside `npm run lint` and `npm run format:check`. See ARCHITECTURE.md's Testing section for exactly what each one checks.

## Status

Working prototype, not a production integration. See ARCHITECTURE.md's "Explicitly out of scope" section for what this deliberately does not do.
