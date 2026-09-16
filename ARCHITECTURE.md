# sc-workorders-mcp — Architecture

A local, read-only MCP (Model Context Protocol) server that lets an LLM query ServiceChannel work orders and locations through natural-language tool calls, instead of the LLM constructing raw API requests itself.

**Status:** working prototype, not a production integration. Built to answer one question for a larger platform business case: what does a real workflow against ServiceChannel's API actually cost in latency and tokens? It is deliberately small — two data types, three tools, no writes.

## What it does

Three MCP tools, all read-only:

| Tool | Input | Output |
|---|---|---|
| `search_work_orders` | `status`, `trade`, `locationId`, `dateFrom`, `dateTo`, `providerId`, `providerName`, `maxResults` (all optional) | `{ count, workOrders: [...] }` |
| `get_work_order` | `workOrderId` (required) | one work order object |
| `search_locations` | `locationId`, `name`, `storeId`, `city`, `state`, `maxResults` (all optional) | `{ count, locations: [...] }` |

Both work-order tools include the assigned `provider` (`{id, name, contactName, phone, email}`, or `null` if unassigned) on every result — see the `$expand` note below.

`search_locations` exists so an agent can resolve a location it only knows by name (e.g. "Main Street Store") into the numeric `locationId` the other two tools require — see [Design decisions](#design-decisions) for why it also serves as the single-location "get" endpoint.

## How it works, end to end

```
LLM (Claude)
   │  tool call: search_work_orders({ status: "OPEN", locationId: 123 })
   ▼
src/index.ts          — MCP tool registration & routing
   │  validates input against a Zod schema
   ▼
src/sc-client.ts       — buildFilter() turns whitelisted fields into an OData $filter string
   │
   ▼
apiFetch()             — attaches a cached bearer token, calls the ServiceChannel API
   │
   ├─ getToken() — returns cached token if not expired, else fetchToken()
   │
   ▼
ServiceChannel Sandbox2 REST/OData API
   │  raw JSON response (verbose, ServiceChannel's native field names/shapes)
   ▼
toCompactWorkOrder() / toCompactLocation()  — reshape to a small, stable, agent-friendly object
   │
   ▼
MCP tool result (JSON text + structuredContent)
   ▼
LLM reads the compact result and answers the user
```

Two design choices carry the whole server:

1. **The LLM never touches the underlying API directly.** It calls a typed tool with a handful of whitelisted parameters; the server is the only thing that ever constructs an OData query string. This is the injection-safety boundary — there's no way to pass through an arbitrary `$filter`.
2. **Every response is reshaped before it reaches the LLM.** ServiceChannel's raw objects have 40+ fields per work order, half of them irrelevant or duplicated (see [API quirks](#servicechannel-api-quirks-worth-knowing) below). `toCompactWorkOrder`/`toCompactLocation` cut that down to ~9 fields each — smaller token footprint, and a stable shape the LLM can rely on even if ServiceChannel adds fields upstream.

## Authentication

ServiceChannel uses OAuth 2.0 password grant against a sandbox-specific login host.

```
POST https://sb2login.servicechannel.com/oauth/token
Authorization: Basic base64(client_id:client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=password&username=...&password=...
```

- Access token: short-lived (600s / 10 min). Cached in memory (`tokenCache` module-level variable in `sc-client.ts`) and refreshed whenever the cache is empty or within 30s of expiry.
- Refresh token: also returned, valid 30 days, but **unused** — the prototype just re-runs the password grant on expiry instead of implementing refresh-token rotation. Fine for a local dev tool; not fine for anything long-running or multi-user.
- No token is ever persisted to disk. Every process restart re-authenticates from scratch.
- **Critical gotcha:** a bad or unregistered OAuth client doesn't fail the token call with 401 — it silently redirects (`HTTP 302`) to an HTML login page (`/Account/LogOn`). A naive HTTP client following redirects would get back an HTML page and either crash on JSON parsing or (worse) look like a slow success. `fetchToken()` uses `redirect: "manual"` specifically so a 3xx response is caught and raised as a clear "auth failed" error instead.
- Env-based credentials only (`SC_CLIENT_ID`, `SC_CLIENT_SECRET`, `SC_USERNAME`, `SC_PASSWORD`) — see [Configuration](#configuration).

## Request flow for a tool call

Using `search_work_orders` as the example (`get_work_order` and `search_locations` follow the same shape):

1. MCP client (Claude) calls the tool with arguments; the SDK validates them against the tool's Zod `inputSchema` before the handler ever runs.
2. The handler calls `buildFilter()`, which walks a **fixed list of known-safe fields** (`status`, `trade`, `locationId`, `dateFrom`, `dateTo`, `providerId`, `providerName`) and, for each one present, appends one OData clause:
   - `Status/Primary eq 'OPEN'`
   - `Trade eq 'ALARMS'`
   - `LocationId eq 123`
   - `CreatedDate ge 2026-06-01T00:00:00Z` / `CreatedDate le 2026-06-30T23:59:59Z`
   - `Provider/Id eq 2000123456`
   - `contains(Provider/Name,'acme')`

   Clauses are joined with `and`. Any field not on the list is simply not representable — this is what makes it safe to expose to an LLM.
3. `apiFetch()` gets a valid token (cached or freshly fetched), builds the full URL (`{API_BASE_URL}/v3/odata/workorders?$filter=...&$expand=Provider&$top=...`), and issues the GET. `$expand=Provider` is required on every work-order call — `Provider` is an OData navigation property, not a plain field, so it's simply absent from the response without it (see quirk below).
4. Response handling:
   - `401` → clear the token cache and retry **once** with a fresh token; a second `401` is a hard failure.
   - `429` → throw immediately with the `Retry-After` header value in the message. No automatic backoff/retry loop — this is a prototype, not a production client.
   - `404` → "Work order not found."
   - any other non-2xx → generic error including status and response body.
5. Each raw work order in `data.value` is passed through `toCompactWorkOrder()`.
6. The handler returns both a JSON text block (`content`) and a `structuredContent` object — the MCP SDK's modern pattern, giving clients that support structured output a typed object instead of having to re-parse the text block.

## File layout

```
sc-workorders-mcp/
├── package.json          # deps: @modelcontextprotocol/sdk, zod. No axios — native fetch (Node 20+) is enough.
├── tsconfig.json          # rootDir "." so it compiles both src/ and the root-level test.ts
├── .env.example           # committed, empty values — documents required config
├── .env                   # gitignored, real sandbox credentials (local only)
├── src/
│   ├── index.ts            # McpServer setup, all 3 tool registrations, stdio entrypoint
│   └── sc-client.ts        # auth, token cache, apiFetch, filter builders, response shapers
└── test.ts                 # single smoke test, runs against the LIVE sandbox API (no mocks)
```

Build output goes to `dist/`, mirroring the source layout as `dist/src/index.js` and `dist/test.js` — note `main`/`start` in `package.json` point at `dist/src/index.js`, not `dist/index.js`, because `test.ts` living at the project root (not under `src/`) forces `rootDir` to be `.` rather than `./src`.

## Configuration

All config is environment variables, read once at module load in `sc-client.ts`; missing required vars fail fast (stderr message + `process.exit(1)`) rather than failing confusingly on the first API call.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SC_CLIENT_ID` | yes | — | Must be a client registered **in the target environment itself** — see quirk below |
| `SC_CLIENT_SECRET` | yes | — | |
| `SC_USERNAME` | yes | — | |
| `SC_PASSWORD` | yes | — | |
| `SC_TOKEN_URL` | no | `https://sb2login.servicechannel.com/oauth/token` | Swap for prod/other sandbox |
| `SC_API_BASE_URL` | no | `https://sb2api.servicechannel.com` | Swap for prod/other sandbox |
| `SC_TEST_WORKORDER_ID` | no | first result from a live search | Used by `test.ts` only |

## ServiceChannel API quirks worth knowing

These were discovered by live trial against the SB2 sandbox and aren't obvious from the published docs — anyone extending this server or rebuilding it against a different environment should re-verify them rather than assume:

- **A prod-synced OAuth client does not work in the sandbox.** ServiceChannel's SB2 sandbox syncs data from production weekly, but an OAuth client created in production and carried over by that sync does not authenticate against SB2 — every token request 302-redirects to a login page regardless of grant type. The client that works has to be created **directly in the SB2 environment itself** (visible as an "API Integration" in the SB2 web UI). This cost significant debugging time; if this server is pointed at a new environment, provision credentials natively in that environment first.
- **`Status` is a nested object, not a flat string:** `{ Primary: string, Extended: string, CanCreateInvoice: boolean }`. `Primary` is `Edm.String` in the OData `$metadata` — i.e. **not a closed enum** server-side, even though only `OPEN`, `IN PROGRESS`, and `COMPLETED` have been observed live. Don't hardcode a strict enum against it.
- **Nested-field filtering works:** `$filter=Status/Primary eq 'COMPLETED'` is valid syntax against this API.
- **Date literals are bare ISO, no wrapper:** `CreatedDate ge 2026-06-01T00:00:00Z` works. The older OData v3 `datetime'...'` literal syntax is not needed — this API is v4-shaped internally (note the `@odata.context` response key) despite living under a `/v3/` URL path.
- **`$top` is silently capped at 50** by the server regardless of what's requested — confirmed empirically, not documented. The tools mirror this cap in their Zod schemas (`maxResults` max 50).
- **The `/workorders({id})` single-item syntax works fine**, but the equivalent `/locations({id})` syntax does **not** — it returns HTTP 500 ("Multiple actions were found that match the request... GetLocationsObsolete... GetLocations... GetUserLocations...") due to an ambiguous route on ServiceChannel's side. The workaround, used here, is to fetch a single location via `$filter=Id eq {id}` on the list endpoint instead of the parens syntax.
- **`contains()` is case-insensitive** on at least `Name` and `Address2` — confirmed by searching `'Maple'` and matching a record containing lowercase `'maple'`. This is what makes `search_locations`'s fuzzy name match usable without any client-side fuzzy-matching library.
- **`Trade` and `Priority` are display strings**, each paired with a separate `*Id` integer field (`TradeId`, `PriorityId`) that this server doesn't currently expose.
- **`Provider` (the assigned vendor) is an OData navigation property, not a plain field** — checked via the `$metadata` document (`<NavigationProperty Name="Provider" Type="...Provider" />` on the `WorkOrder` entity type). A plain query for a work order simply omits it entirely; it only appears with `$expand=Provider` added to the request, on both the list endpoint and the `(id)` single-item endpoint (both confirmed live). Filtering on the expanded field also works: `Provider/Id eq {id}` for exact match, `contains(Provider/Name,'x')` for fuzzy — and like `Name`/`Address2` on locations, this `contains()` is case-insensitive too (confirmed: filtering `'acme'` matched a provider named `ACME REFRIGERATION CO`). The nested `Provider` object's contact-name field is called `MainContact`, not `ContactName` or similar — easy to guess wrong.
- Several date fields (`CreatedDate`, `ScheduledDate`, etc.) come paired with a `*_DTO` variant carrying the same value at higher precision — safely ignorable.

## Design decisions

- **Native `fetch`, not `axios` or another HTTP client.** Node 20+ ships `fetch` in the global scope; adding a dependency for something the runtime already provides fails the "already-installed/stdlib first" bar this project was built to.
- **No `resolve_location`/`get_location` split.** The original plan considered a separate location-lookup tool. Once `/locations({id})` turned out to be broken server-side, a single `search_locations` tool that accepts an optional exact `locationId` covers both the "search by name" and "get by id" cases through the one working code path (`$filter=Id eq {id}`), so a second tool would have been pure duplication.
- **No retry/backoff engineering.** A 429 throws with the `Retry-After` value surfaced in the error message; there's no automatic queuing or exponential backoff. This is a conscious scope cut for a prototype whose job is to produce cost/latency numbers, not to be robust under load.
- **No persistent token storage, no refresh-token flow.** The access token lives in a module-level variable and is re-fetched via password grant on expiry. Acceptable for a single local process; would need real credential handling for anything shared or long-lived.
- **Compact response shape over raw passthrough.** Every tool reshapes ServiceChannel's native response before returning it, trading completeness (some fields, like `TradeId`/`PriorityId`, aren't exposed) for a smaller, stable, predictable schema — the right tradeoff for token cost and for shielding the LLM from upstream schema churn.

## Explicitly out of scope

Writes/mutations of any kind, multi-tenant support, a policy/approval engine, an audit database, agent-to-agent (A2A) protocol support, webhooks, persistent or rotated token storage, retry/backoff engineering, and remote/HTTP transport (this is stdio-only, meant to run as a local subprocess next to a single Claude session).

## How to rebuild this from scratch

1. **Get sandbox credentials provisioned in the target environment itself** (see the OAuth quirk above) — this is the step most likely to eat time.
2. `npm init`, add `@modelcontextprotocol/sdk` and `zod` as dependencies, TypeScript + `@types/node` as dev dependencies. Target Node ≥20.6 for built-in `fetch` and `--env-file`.
3. Write a token-cache + `apiFetch` wrapper first, in isolation, and prove it against the real API with a throwaway script before touching MCP at all — auth quirks (redirects instead of errors, sandbox-vs-prod client scoping) are much easier to debug outside the MCP protocol layer.
4. Once raw API access works, build one Zod-validated MCP tool end to end (schema → filter builder → API call → response shaping → `registerTool`), verify it live, then repeat for the next tool.
5. Write one smoke test (`test.ts`) that hits the live API with no mocking — for an integration this thin, a mocked test would mostly test the mock.
6. Wire into Claude Code with `claude mcp add <name> -s user -e KEY=value ... -- node /absolute/path/to/dist/.../index.js` (user scope so it's available in any future session, not just one project directory).

## Testing

`npm test` runs `tsc` then `node --env-file=.env dist/test.js` — a single script (`test.ts`) with five checks, all against the live SB2 API:

1. Token fetch + a basic list call succeeds.
2. `search_work_orders` respects `maxResults` and each result has an `id` + `status`.
3. `get_work_order` returns the requested ID, and its `provider` field is either `null` or a well-formed `{id, name, ...}` object.
4. `search_work_orders` filtered by `providerName` returns at least one match, and every result's provider name actually contains the filter term (case-insensitive, matching the API's own `contains()` behavior).
5. `search_locations` fuzzy-matches a known location name and each result has an `id` + `name`.

Each check also logs its latency — this is the actual point of the prototype: real numbers for the business case, not just pass/fail.
