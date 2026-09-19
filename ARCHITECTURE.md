# sc-workorders-mcp — Architecture

A local, read-only MCP (Model Context Protocol) server that lets an LLM query ServiceChannel work orders and locations through natural-language tool calls, instead of the LLM constructing raw API requests itself.

**Status:** working prototype, not a production integration. Built to answer one question for a larger platform business case: what does a real workflow against ServiceChannel's API actually cost in latency and tokens? It is deliberately small — five data types, eight tools, no writes.

## What it does

Eight MCP tools, all read-only:

| Tool | Input | Output |
|---|---|---|
| `search_work_orders` | `status`, `trade`, `category`, `locationId`, `dateFrom`, `dateTo`, `scheduledDateFrom`, `scheduledDateTo`, `completedDateFrom`, `completedDateTo`, `providerId`, `providerName`, `sortBy`, `sortOrder`, `offset`, `maxResults`, `countOnly` (all optional) | `{ count, totalCount, hasMore, workOrders: [...] }`, or just `{ totalCount }` when `countOnly: true` |
| `get_work_order` | `workOrderId` (required) | one work order object |
| `get_work_order_notes` | `workOrderId` (required) | `{ count, notes: [...] }` |
| `get_work_order_assets` | `workOrderId` (required) | `{ count, totalCount, truncated, assets: [...] }` |
| `get_work_order_activities` | `workOrderId` (required) | `{ count, activities: [...] }` |
| `search_locations` | `locationId`, `name`, `storeId`, `city`, `state`, `maxResults` (all optional) | `{ count, locations: [...] }` |
| `search_trades` | `name`, `maxResults` (all optional) | `{ count, trades: [...] }` |
| `count_work_orders` | `groupBy` (required: `status`/`trade`/`category`) plus the same filters as `search_work_orders` | `{ totalCount, groups: [{value, count}], other, truncated }` |

Both work-order tools (`search_work_orders`, `get_work_order`) include the assigned `provider` (`{id, name, contactName, phone, email}`, or `null` if unassigned) and `invoice` (`{id, number, status, total, balance, invoiceDate, paidDate}`, or `null` if none), plus `tradeId`/`priorityId`/`category`/`categoryId`, on every result — see the `$expand` note below. `search_work_orders` supports paging (`offset`, capped `maxResults`) and sorting (`sortBy`/`sortOrder`) — see [Pagination and sorting](#pagination-and-sorting).

`search_locations` exists so an agent can resolve a location it only knows by name (e.g. "Main Street Store") into the numeric `locationId` the other tools require — see [Design decisions](#design-decisions) for why it also serves as the single-location "get" endpoint. `search_trades` plays the same discovery role for `search_work_orders`' `trade` filter, which requires an exact string match with no other way to know valid values in advance.

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
2. **Every response is reshaped before it reaches the LLM.** ServiceChannel's raw objects have 40+ fields per work order, half of them irrelevant or duplicated (see [API quirks](#servicechannel-api-quirks-worth-knowing) below). `toCompactWorkOrder`/`toCompactLocation` cut that down to a dozen or so fields each — smaller token footprint, and a stable shape the LLM can rely on even if ServiceChannel adds fields upstream.

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
2. The handler calls `buildFilter()`, which walks a **fixed list of known-safe fields** (`status`, `trade`, `category`, `locationId`, `dateFrom`, `dateTo`, `scheduledDateFrom`, `scheduledDateTo`, `completedDateFrom`, `completedDateTo`, `providerId`, `providerName`) and, for each one present, appends one OData clause:
   - `Status/Primary eq 'OPEN'`
   - `Trade eq 'ALARMS'`
   - `Category eq 'MAINTENANCE'`
   - `LocationId eq 123`
   - `CreatedDate ge 2026-06-01T00:00:00Z` / `CreatedDate le 2026-06-30T23:59:59Z` (same `ge`/`le` pattern also used for `ScheduledDate`/`CompletedDate`)
   - `Provider/Id eq 2000123456`
   - `contains(Provider/Name,'acme')`

   Clauses are joined with `and`. Any field not on the list is simply not representable — this is what makes it safe to expose to an LLM. `search_work_orders` separately calls `buildOrderBy()` for the `$orderby` clause, using the same whitelist principle (see [Pagination and sorting](#pagination-and-sorting)).
3. `apiFetch()` gets a valid token (cached or freshly fetched), builds the full URL (`{API_BASE_URL}/v3/odata/workorders?$filter=...&$orderby=...&$select=...&$expand=Provider($select=...),Invoice($select=...)&$top=...&$skip=...&$count=true`), and issues the GET. `$expand` is required on every work-order call for both `Provider` and `Invoice` — both are OData navigation properties, not plain fields, so they're simply absent from the response without it (see quirk below). `$select` is always the exact field list `toCompactWorkOrder` actually reads (`WORKORDER_SELECT` in `sc-client.ts`, kept next to the mapper on purpose); the nested `$select` inside each `$expand()` term does the same trimming one level down (confirmed live: composes cleanly, e.g. trims `Provider` from ~28 fields to the 5 `toCompactWorkOrder` reads). Both together are `WORKORDER_EXPAND`, also kept next to the mapper.
4. Response handling:
   - `401` → clear the token cache and retry **once** with a fresh token; a second `401` is a hard failure.
   - `429` → throw immediately with the `Retry-After` header value in the message. No automatic backoff/retry loop — this is a prototype, not a production client.
   - `404` → "Work order not found."
   - any other non-2xx → generic error including status and response body.
5. Each raw work order in `data.value` is passed through `toCompactWorkOrder()`.
6. The handler returns both a JSON text block (`content`) and a `structuredContent` object — the MCP SDK's modern pattern, giving clients that support structured output a typed object instead of having to re-parse the text block.

## Pagination and sorting

`search_work_orders` takes `offset` (→ `$skip`) and always requests `$count=true`. The response includes `totalCount` (from the API's `@odata.count`) and a computed `hasMore` (`offset + returned-count < totalCount`) — **`hasMore` is computed client-side, not read from the API**, because this API returns no `@odata.nextLink` or equivalent even when a filter matches far more rows than `$top` returned (see quirk below). To page through results, repeat the call with `offset` increased by the previous page's `count` until `hasMore` is `false`.

`countOnly: true` sends `$top=0&$count=true` with the same `$filter` and no `$select`/`$expand`/`$orderby`, returning only `{ totalCount }`. `$top=0` is accepted by this API (HTTP 200, empty `value`, real `@odata.count`; confirmed live), so a "how many" question costs one small request instead of a full work-order row.

Sorting goes through `buildOrderBy(sortBy, sortOrder)` in `sc-client.ts` — a small whitelist map (`createdDate → CreatedDate`, `scheduledDate → ScheduledDate`, `completedDate → CompletedDate`) that turns a Zod-enum-validated field name into an OData `$orderby` clause (e.g. `CreatedDate desc`). Same principle as `buildFilter`: the LLM picks from an enum, never supplies a raw OData property name. Sorting and filtering compose in the same request with no issues (confirmed live).

## Grouped counts

`count_work_orders` exists because `$apply=groupby` is unsupported here (HTTP 400), so per-group counts are built from one `$count` request (`$top=0&$count=true`) per value, in `countWorkOrdersBy()` in `sc-client.ts`. `groupBy` goes through a whitelist map (`status → Status/Primary`, `trade → Trade`, `category → Category`), same principle as `buildFilter`; the base `$filter` comes from the same `buildFilter`, so all search filters compose.

Two ways of finding the values to count, because only trades have a directory:
- **`trade`:** lists `/v3/odata/trades` (1 request), then one count per trade.
- **`status` / `category`:** "peel" discovery. Fetch one row that matches none of the values seen so far (`$top=1`, `Field ne 'A' and Field ne 'B'`), count its value, repeat until no row is left. This costs 2 requests per distinct value and finds values nobody hardcoded (on the full sandbox, `Status/Primary` includes `INVOICED`, which was not among the three previously observed).

The response reports `other = totalCount - sum(groups)` so nothing is silently dropped, and `truncated: true` when the request budget (`GROUP_REQUEST_BUDGET`, 15) or a 429 cut discovery short (a 429 mid-way returns the counts gathered so far instead of throwing). That budget means `groupBy: "trade"` over the whole dataset (22 trades) comes back truncated with 13 trades counted; narrow the filters to get all of them. A null value can't be excluded with `ne`, so it stops the peel and lands in `other`. The API's rate limit is tight (see quirk below), so requests run sequentially and the tool description warns the caller about cost.

## Work order notes

`get_work_order_notes` calls `GET /v3/odata/workorders({id})/notes` directly — a plain sub-resource GET, no `$expand`, no `$filter`. This is a different request shape than every other tool in this codebase (which all hit `/v3/odata/workorders` or `/v3/odata/locations` directly), because **`$expand=notes` doesn't work** — see the quirk below. Each note maps through `toCompactNote()` to `{id, number, text, createdBy, createdDate}`, dropping several less-useful fields (`DocumentId`, `GroupId`, `Visibility`, `IsAttachmentNote`, `ActionResolveDetails`, etc.) that exist on the raw `Note` entity per `$metadata`.

## Work order assets

`get_work_order_assets` calls `GET /v3/odata/workorders({id})?$select=Id,AssetCount&$expand=Assets($select=...;$top=ASSET_CAP)` — the same single-item endpoint as `get_work_order`, not a separate sub-resource path (unlike notes/activities). `Assets` is an OData navigation property (like `Provider`/`Invoice`), so it only appears with `$expand`. The nested `$top=50` inside `$expand` is a real, working cap on this endpoint (see quirk below) — it's what resolves the "no response-size/truncation safeguard" tech debt item. The work order's own `AssetCount` field (fetched via `$select`) gives the true total, so the response can report `{ count, totalCount, truncated, assets }`, the same `totalCount`/`hasMore`-style shape as `search_work_orders`' pagination, just applied to a single-resource cap instead of paging. `toCompactAsset()` maps each raw `Asset` to `{id, tag, manufacturer, modelNo, serialNo, trade, type, active, locationId}` — descriptive fields are frequently `null` in the sandbox (see quirk below), so the mapper is null-safe on every field but `id`/`active`.

## Work order activities

`get_work_order_activities` calls `GET /v3/odata/workorders({id})/workactivities` directly — a plain sub-resource GET, same shape as `get_work_order_notes` (`$expand=workactivities` is broken the same way `$expand=notes` is, see quirk below). Each activity maps through `toCompactActivity()` to `{id, timeIn, timeOut, technician, resolutionCode, workType, techsCount}`, sorted client-side by `timeIn` ascending (oldest first, matching notes' ordering) since the API doesn't confirm a server-side order on this endpoint. `technician` is read from the nested `User.FullName` field — `$select` pulls the whole `User` object in one request, same as it trims other fields.

## File layout

```
sc-workorders-mcp/
├── package.json          # deps: @modelcontextprotocol/sdk, zod. No axios — native fetch (Node 20+) is enough.
├── tsconfig.json          # rootDir "." so it compiles src/, test.ts, and unit.test.ts together
├── eslint.config.js       # ESLint 10 flat config, typescript-eslint recommended + one override (see Design decisions)
├── .prettierrc.json       # printWidth 120, not the 80 default — see Design decisions
├── .prettierignore        # scopes Prettier to source files only, not *.md/package.json
├── .env.example           # committed, empty values — documents required config
├── .env                   # gitignored, real sandbox credentials (local only)
├── src/
│   ├── index.ts            # McpServer setup, all 8 tool registrations, stdio entrypoint
│   └── sc-client.ts        # auth, token cache, apiFetch, filter builders, response shapers, $select constants
├── test.ts                 # live integration smoke test, runs against the LIVE sandbox API (no mocks)
└── unit.test.ts             # pure-function tests (buildFilter, buildOrderBy, toCompact*) — no credentials, no network, CI-safe
```

Build output goes to `dist/`, mirroring the source layout as `dist/src/index.js`, `dist/test.js`, and `dist/unit.test.js` — note `main`/`start` in `package.json` point at `dist/src/index.js`, not `dist/index.js`, because `test.ts`/`unit.test.ts` living at the project root (not under `src/`) forces `rootDir` to be `.` rather than `./src`.

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
- **`$top` is silently capped at 50** by the server regardless of what's requested — confirmed empirically, not documented. `$top=0` works and returns just the count. The tools mirror this cap in their Zod schemas (`maxResults` max 50).
- **The `/workorders({id})` single-item syntax works fine**, but the equivalent `/locations({id})` syntax does **not** — it returns HTTP 500 ("Multiple actions were found that match the request... GetLocationsObsolete... GetLocations... GetUserLocations...") due to an ambiguous route on ServiceChannel's side. The workaround, used here, is to fetch a single location via `$filter=Id eq {id}` on the list endpoint instead of the parens syntax.
- **`contains()` is case-insensitive** on at least `Name` and `Address2` — confirmed by searching `'Maple'` and matching a record containing lowercase `'maple'`. This is what makes `search_locations`'s fuzzy name match usable without any client-side fuzzy-matching library.
- **`Trade` and `Priority` are display strings**, each paired with a separate `*Id` integer field (`TradeId`, `PriorityId`) that this server doesn't currently expose.
- **`Provider` (the assigned vendor) is an OData navigation property, not a plain field** — checked via the `$metadata` document (`<NavigationProperty Name="Provider" Type="...Provider" />` on the `WorkOrder` entity type). A plain query for a work order simply omits it entirely; it only appears with `$expand=Provider` added to the request, on both the list endpoint and the `(id)` single-item endpoint (both confirmed live). Filtering on the expanded field also works: `Provider/Id eq {id}` for exact match, `contains(Provider/Name,'x')` for fuzzy — and like `Name`/`Address2` on locations, this `contains()` is case-insensitive too (confirmed: filtering `'acme'` matched a provider named `ACME REFRIGERATION CO`). The nested `Provider` object's contact-name field is called `MainContact`, not `ContactName` or similar — easy to guess wrong.
- **`Invoice` is the same pattern as `Provider`, and composes with it.** Also a navigation property (singular, one invoice per work order — `null` when uninvoiced), requires `$expand=Invoice`, works on both list and single-item endpoints. Confirmed live with a real linked record (work order `357049342` → invoice `175688826`). `$expand=Provider,Invoice` in one request returns both correctly — this API doesn't choke on multiple navigation properties in the same `$expand`, unlike some of its other rough edges. **Bonus finding: nested `$expand(...)($select=...)` works too** — `$expand=Provider($select=Id,Name,...),Invoice($select=Id,Number,...)` trims each expanded object down to only the fields actually used, confirmed live and composing cleanly with a `$select` on the outer work-order fields at the same time. Worth checking for any future `$expand`, not just these two.
- Several date fields (`CreatedDate`, `ScheduledDate`, etc.) come paired with a `*_DTO` variant carrying the same value at higher precision — safely ignorable.
- **The rate limit is much tighter than it looks.** A 429 body reads `Request has been throttled. Your current Application limit is [40] per [1] minute`, and the `Retry-After` header is an HTTP *date* (e.g. `Sat, 19 Sep 2026 00:52:33 GMT`), not a seconds count. But measured live from a fresh window, only **20** sequential `$top=0&$count=true` calls succeeded (about 12s) before the 429. Treat ~20 requests/min per application as the working budget: 22 parallel requests all 429 immediately, and the live test suite has to wait out the window before its multi-request check. Blocked attempts appear to extend the window, so back off rather than retry.
- **`$apply=groupby(...)` is not supported** — HTTP 400 (`'with' expected at position 42`). Server-side aggregation isn't available; per-group counts have to be one `$count` request per group.
- **No `@odata.nextLink` is ever returned**, even when `$count=true` reports far more matches than `$top` returned (confirmed with a filter matching 4,363 rows against `$top=5`). `$skip` itself works correctly (confirmed: `$skip=5` returns a genuinely different, non-overlapping continuation of the same ordering) and `$count=true` does return a real `@odata.count` — but "are there more results" has to be computed client-side (`offset + returned-count < totalCount`), not read off a link the server provides. `search_work_orders`'s `hasMore` field is exactly that client-side computation.
- **`$expand=notes` is broken** on both `/v3/odata/workorders` and `/v3/odata/workorders({id})` — it fails server-side with `"The member 'WorkOrder.NotesCollection' has no supported translation to SQL"` (or a bare `HTTP 500` on the list endpoint with a filter). The only way to actually fetch a work order's notes is the sub-resource path `GET /v3/odata/workorders({id})/notes` directly, with no `$expand` involved at all — confirmed live, returns the full note collection cleanly. This is why `get_work_order_notes` is a separate tool/request rather than a field folded into `get_work_order`.
- **`$expand=Assets` behaves differently on the list endpoint vs. the single-item endpoint.** On the *list* endpoint (`/v3/odata/workorders?$filter=...`), the nested `Assets` collection is silently capped at 50 regardless of what `$top` is requested inside `$expand` (confirmed: a work order with `AssetCount: 60` still came back with only 50 assets even when `$expand=Assets($top=100)` was requested). On the *single-item* endpoint (`/workorders({id})`), there's no such cap — the same 60-asset work order returned all 60 with no `$top` requested — but requesting `$expand=Assets($top=N)` genuinely caps it server-side (confirmed: `$top=10` returned exactly 10 of 60). `get_work_order_assets` uses the single-item endpoint specifically so this real, working cap is available; nested `$select` also works inside `$expand=Assets(...)`, trimming each asset object the same way it does for `Provider`/`Invoice`. This is the same "list vs. single-item inconsistency" family as the `/locations({id})` bug, but here the single-item form is the more capable one, not the broken one.
- **Asset descriptive fields are frequently null in this sandbox.** `Tag`, `Manufacturer`, `ModelNo`, `SerialNo`, `Trade`, and `Type` were `null` on every asset checked live, even ones tied to real work orders — only `Id`, `Active`, `LocationId`, and `TradeId` were reliably populated. Not a shape bug; the sandbox's asset records just aren't fully filled out. Don't assume a non-null value for these fields when testing.
- **`$expand=workactivities` is broken** on `/v3/odata/workorders({id})`, the same failure pattern as `$expand=notes` (SQL-translation error). The working path is the sub-resource `GET /v3/odata/workorders({id})/workactivities`, confirmed live with a real check-in/check-out record: `{Id, WorkOrderId, TimeIn, TimeOut, IsTimeEdited, User: {Id, UserName, FullName, Email, LevelInfo}, CallerId, ResolutionCode, WorkType, HasCheckInInfo, HasCheckListResponse, TechsCount, Name, CreatedBy}`. `$select` works on this sub-resource, including pulling the nested `User` object whole.
- **There is no standalone provider directory endpoint**, unlike locations. `GET /v3/odata/providers` returns `HTTP 500` ("Multiple actions were found that match the request" — an ambiguous controller-action collision, the same class of bug as the `/locations({id})` issue but on the bare collection this time, not just the single-item form). `GET /v3/odata/providers/detailedProviders` returns `404` despite both `providers` and `detailedProviders` being declared as top-level `EntitySet`s in `$metadata` — they're declared in the OData model but not actually backed by a working controller. Expanding providers through a location (`/v3/odata/locations?...&$expand=providers`) also 500s. **The only working way to see provider data on this API is the existing per-work-order `$expand=Provider`** (singular, on a work order) — there is no way to build a `search_providers` directory tool analogous to `search_locations` against this API as it currently stands. Don't re-attempt this without a documented change on ServiceChannel's side.

## Design decisions

- **Native `fetch`, not `axios` or another HTTP client.** Node 20+ ships `fetch` in the global scope; adding a dependency for something the runtime already provides fails the "already-installed/stdlib first" bar this project was built to.
- **No `resolve_location`/`get_location` split.** The original plan considered a separate location-lookup tool. Once `/locations({id})` turned out to be broken server-side, a single `search_locations` tool that accepts an optional exact `locationId` covers both the "search by name" and "get by id" cases through the one working code path (`$filter=Id eq {id}`), so a second tool would have been pure duplication.
- **No retry/backoff engineering.** A 429 throws with the `Retry-After` value surfaced in the error message; there's no automatic queuing or exponential backoff. This is a conscious scope cut for a prototype whose job is to produce cost/latency numbers, not to be robust under load.
- **No persistent token storage, no refresh-token flow.** The access token lives in a module-level variable and is re-fetched via password grant on expiry. Acceptable for a single local process; would need real credential handling for anything shared or long-lived.
- **Compact response shape over raw passthrough.** Every tool reshapes ServiceChannel's native response before returning it, trading completeness (e.g. `Notes`' verbose sub-fields aren't all exposed) for a smaller, stable, predictable schema — the right tradeoff for token cost and for shielding the LLM from upstream schema churn.
- **`hasMore` and hardcoded whitelist maps over generic pass-through.** Both `buildOrderBy`'s field whitelist and `search_work_orders`'s `hasMore` computation exist because the underlying API doesn't provide either directly (no `$orderby`-safe way to accept a raw field name from an LLM; no `@odata.nextLink`) — this is the same whitelist-and-reshape philosophy as `buildFilter`, applied to two more gaps the raw API leaves open.
- **`$select`/`$expand` constants live next to their `toCompact*` mapper, not centralized.** `WORKORDER_SELECT`/`WORKORDER_EXPAND`/`LOCATION_SELECT`/`NOTE_SELECT`/`TRADE_SELECT` are exported right beside the function that consumes their shape, with a comment saying so explicitly — the field lists have to stay in sync, and co-location is what makes "I added a field to the mapper but forgot the `$select`" an easy mistake to *notice*, not just an easy mistake to *avoid*. `WORKORDER_EXPAND` bundles the nested `$select` for both `Provider` and `Invoice` in one constant since they're always fetched together.
- **No shared helper for the parens-broken/`$filter=Id eq {id}` workaround, despite it recurring.** It's used today only in `buildLocationFilter`; a shared `getByIdViaFilter()` for one real call site would be an abstraction with a single implementation. Instead, the one existing call site carries a comment pointing future entities (invoices is a known future one, see `BACKLOG.md`) at the same one-line pattern. Revisit this decision — and actually extract a helper — the second time an entity needs it, not before.
- **Lint/format tooling added once the codebase had enough surface for style drift to matter, not from day one.** ESLint 10 (`typescript-eslint` recommended config) and Prettier 3 were added together; `@typescript-eslint/no-explicit-any` is explicitly turned off rather than left to flag the ~9 intentional `any` usages on raw API responses (that's a deliberate choice documented above, not an oversight — silencing the rule that would fight a deliberate pattern is more honest than leaving noisy warnings nobody will act on). Prettier's `printWidth` is set to 120, not the 80 default, matching this codebase's existing line-length habits (long chained `.describe()` calls, wide `$select` constants) — the goal was a one-time, low-churn adoption reformat, not fighting the existing style. `.prettierignore` scopes Prettier to source files only; running it over `*.md`/`package.json` would reformat prose and JSON key ordering that has nothing to do with code style.

## Explicitly out of scope

Writes/mutations of any kind, multi-tenant support, a policy/approval engine, an audit database, agent-to-agent (A2A) protocol support, webhooks, persistent or rotated token storage, retry/backoff engineering, and remote/HTTP transport (this is stdio-only, meant to run as a local subprocess next to a single Claude session).

## How to rebuild this from scratch

1. **Get sandbox credentials provisioned in the target environment itself** (see the OAuth quirk above) — this is the step most likely to eat time.
2. `npm init`, add `@modelcontextprotocol/sdk` and `zod` as dependencies, TypeScript + `@types/node` as dev dependencies. Target Node ≥20.6 for built-in `fetch` and `--env-file`.
3. Write a token-cache + `apiFetch` wrapper first, in isolation, and prove it against the real API with a throwaway script before touching MCP at all — auth quirks (redirects instead of errors, sandbox-vs-prod client scoping) are much easier to debug outside the MCP protocol layer.
4. Once raw API access works, build one Zod-validated MCP tool end to end (schema → filter builder → API call → response shaping → `registerTool`), verify it live, then repeat for the next tool.
5. Write one smoke test (`test.ts`) that hits the live API with no mocking — for an integration this thin, a mocked test would mostly test the mock. Once the pure logic (filter/orderby builders, response mappers) is non-trivial enough to be worth checking in CI, split those into a separate no-credentials `unit.test.ts` rather than trying to make the live test CI-safe.
6. Wire into Claude Code with `claude mcp add <name> -s user -e KEY=value ... -- node /absolute/path/to/dist/.../index.js` (user scope so it's available in any future session, not just one project directory).
7. Add ESLint + Prettier once there's enough surface for style drift to matter — not from day one. Set `printWidth` to match whatever line-length habits already exist rather than the 80-char default, to keep the adoption reformat a one-time, low-churn event.

## Testing

Two independent scripts, deliberately kept separate rather than merged into one file:

**`npm test`** — `tsc` then `node --env-file=.env dist/test.js`. Live integration checks (`test.ts`), fifteen of them, all against the real SB2 API, no mocking, requiring real credentials and real sandbox data:

1. Token fetch + a basic list call succeeds.
2. `search_work_orders` respects `maxResults` and each result has an `id` + `status`.
3. `get_work_order` returns the requested ID, and its `provider` field is either `null` or a well-formed `{id, name, ...}` object.
4. `search_work_orders` filtered by `providerName` returns at least one match, and every result's provider name actually contains the filter term (case-insensitive, matching the API's own `contains()` behavior).
5. `search_locations` fuzzy-matches a known location name and each result has an `id` + `name`.
6. `search_work_orders` filtered by `category` + `completedDateFrom` together returns only matching, non-null-`completedDate` results (uses `category: "REPAIR"` — this sandbox has only 11 work orders total with a non-null `CompletedDate`, and none of them are in the `MAINTENANCE` category, so the test fixture matters here).
7. `search_work_orders` sorted `createdDate desc` returns results in genuinely non-increasing order.
8. Pagination: two `$skip=0`/`$skip=5` pages don't overlap on `id`, and `@odata.count` reports a sane total.
9. `get_work_order_notes` against a known multi-note work order (`355703118`, 9 notes) returns more than one note, each with non-empty `text`/`createdBy`.
10. `get_work_order` against a known invoiced work order (`357049342`) returns a non-null `invoice` with a well-formed `{id, status, ...}` shape.
11. `search_trades` fuzzy-matches a known trade name and each result has an `id` + `name`.
12. `get_work_order_assets` against a known 60-asset work order (`354456038`) returns `totalCount: 60`, a 50-item capped `assets` array, `truncated: true`, and every asset has an `id`.
13. `get_work_order_activities` against a known work order (`355703118`) returns at least one activity with `resolutionCode: "INCOMPLETE"` and `technician: "Leum Fahey"` resolved from the nested `User.FullName`.
14. `search_work_orders` `countOnly` (`$top=0`) with `Trade eq 'HVAC'` returns no rows and a positive `@odata.count` equal to what a normal `$top=1` page reports.
15. `count_work_orders` `groupBy: "status"` with `Trade eq 'HVAC'` discovers at least one status, every group count is positive, `other` is 0, and `totalCount` matches check 14. It waits 61s first, because of the rate limit (below).

Each check also logs its latency — this is the actual point of the prototype: real numbers for the business case, not just pass/fail. **Cannot run in CI** — needs real credentials.

**`npm run test:unit`** — `tsc` then `node dist/unit.test.js`. Pure-function checks (`unit.test.ts`) for `buildFilter`, `buildLocationFilter`, `buildOrderBy`, `buildTradeFilter`, and every `toCompact*` mapper: whitelist behavior, OData string-escaping, null/undefined-safety on missing fields. No network calls, no credentials — it sets placeholder `SC_*` env vars via a dynamic `import()` (a static import would run before the placeholders are set, since ES module imports are hoisted) purely to satisfy `sc-client.ts`'s fail-fast startup check, then never touches the network. **This is the one that runs in CI.**

**CI** (`.github/workflows/build.yml`) runs, on every push/PR: `npm run build`, `npm run lint` (ESLint), `npm run format:check` (Prettier), and `npm run test:unit` — everything that doesn't need live credentials. The live suite stays a local-only, manually-run check.
