# sc-workorders-mcp — Feature Backlog

Living list of proposed, planned, shipped, and rejected features — plus tracked tech debt — for this project. Kept up to date by whoever's working on this repo — directly, or via the `sc-workorders-feedback` skill, which reads and updates this file as part of its normal workflow. Add ideas here as they come up, even ones not being built yet; move them between sections as their status changes; delete anything that's no longer relevant rather than letting it go stale.

## Proposed

Batch added 2026-09-16, live-verified against the real SB2 `$metadata` and API before being listed here (per this project's standing discipline — see `ARCHITECTURE.md`'s API quirks). Each item notes its evidence so a future session doesn't have to re-derive it.

**Prioritized 2026-09-16, re-ranked 2026-10-12** on three axes: confirmed feasibility (live-verified with real data > callable but untested against data > design unverified), value against triage questions this tool already exists to answer, and effort relative to patterns already in the codebase. This ordering isn't fixed — re-prioritize whenever new evidence (real proposal/RFP data lands in the sandbox, a location-rollup spike gets run, etc.) changes any of those three inputs.

### Now

Re-ranked 2026-10-12 after a `$metadata` survey plus one live sample (50 newest sandbox work orders, 3 requests). Same three axes; items below say whether they were probed live or only seen in `$metadata`. Survey result: the API declares entity sets `assets workorders rfps locations trades invoices InvoiceLabor/Material/Travel/Other notes attachments workactivities proposals providerassignment users providers detailedProviders subscribers trucks weatherEvents`; `WorkOrder` has 68 plain properties of which this server maps about 16, and `Invoice` has 57 plus `Labors/Materials/Travels/Others/Payments` navigation properties.

Re-ranked 2026-10-14 after `search_invoices` was parked (see Someday). Now holds one item: cost/origin fields, the only one with live-verified data and real value. Next order: the no-code demo scenario (cheapest), the fixture check (protects every later live test from silent sandbox re-syncs), then `get_invoice` by id (promoted from Later; endpoint verified, but the sandbox has ~1 invoice to test against).

- **Cost and origin fields on work orders** (added 2026-10-12, **#1 as of 2026-10-14**; tracked as an aiwork task) — add `nte`, `price` and `source` to the compact work order, and `region`/`district`/`zip` next to `locationName`, via `$expand=Location($select=Name,Region,District,Zip)`. Evidence (live, 50 newest WOs): `Nte` and `Price` populated on 23/50 (e.g. 650), `Source` on 50/50 (e.g. `PM`), `Zip` 50/50, `Region` 17/50, `District` 12/50. Unlocks spend and mix questions ("open work orders with NTE over $500", "PM vs reactive") with plain-property `$select` additions, no new request. Same shape as the v0.9.0 change: whitelist, mapper, schema, one `test.ts` check, one unit assertion. Probe first: whether `Nte ge 500` and `Source eq 'PM'` filter (numeric and string `eq` work elsewhere; untested here). Not worth mapping: `Tax`, `Resolution`, `ProblemCode`, `AutoInvoice`, `Assignee`, `EstimatedCompletionDate`, `ProjectedCompletionDate`, `IsExpired` were all null/empty on all 50 sampled rows.
### Next

- **Aging / overdue demo scenario, no code** (added 2026-10-12, **Next #1**) — "open work orders scheduled before today, oldest first" is already answerable with `status` + `scheduledDateTo` + `sortBy`. Add it to `DEMOS.md` and the Coverage table after running it live. The date fields that would make a computed `overdue` flag useful (`EstimatedCompletionDate`, `ProjectedCompletionDate`, `IsExpired`) are empty in the sandbox, so a derived flag is not worth building.
- **Fixture drift check** (promoted from Tech Debt 2026-10-12, **Next #2**; see Tech Debt > Open) — the SB2 sandbox re-syncs from production weekly, and `test.ts`/`DEMOS.md` hardcode specific records. Already bitten once: `INVOICED` status vanished from the sandbox between 2026-09-18 and 2026-10-14.
- **`get_invoice` by id** (**Next #3**, promoted from Later > Invoice detail 2026-10-14) — see that entry's evidence; start with the plain 82-field invoice via `GET /v3/invoices/{id}`, line items and payments after.

### Later — valuable, but bigger scope or sequenced behind "Now"/"Next"

- **Invoice detail** (added 2026-10-12; first step promoted to Next #3 on 2026-10-14, this entry keeps the line-item/payment follow-up; no longer waits on `search_invoices`, which is parked) — `get_invoice` via `GET /v3/invoices/{id}` (confirmed live 2026-10-14; the OData parens form 500s) with line items and payments through `Invoice` navigation properties `Labors`, `Materials`, `Travels`, `Others`, `Payments` (declared in `$metadata`; nested `$expand` is known to compose here, but each of these is unprobed). Answers "what was billed and what's been paid". Also `IsDuplicate` as an invoice filter, the natural seed for duplicate-invoice review in the "Assists" tier; unverified.
- **Region / district filters and grouping** (added 2026-10-12) — `Location/Region eq 'South'` on the work-order list, and `count_work_orders groupBy: region`, for portfolio questions. Nested `Location/Name` filtering is confirmed, but `Region` is populated on only 17/50 sampled work orders and `District` on 12/50, so results would be partial in this sandbox. Worth building when the fields land in the compact output (Now) and a question needs them.
- **Attachment metadata** (added 2026-10-12) — `GET /v3/odata/workorders({id})/attachments` is a working sub-resource (HTTP 200, same shape as notes/activities) but returned 0 rows on the probed work order, so shape and usefulness are unverified. Expose `{id, name, description, uploadBy, timeStamp, isInvoiceDigitalCopy}` only; do **not** surface `Uri` (a download link an LLM would hand to a user). Find a work order that actually has attachments before scoping.
- **`server_status` tool** (added 2026-10-12) — read-only: API host, version, token age, requests made in the last 60 seconds from a small in-process window. Makes the ~20 requests/min budget visible to an agent or script before it hits a 429. Not retry or throttling, so it stays inside scope, but the spike saw no 429, so it is low urgency. Reconsider if the rate limit bites in real use.
- **Location-level rollup** (e.g. open-work-order count per location) — genuinely unverified, not just lower-value: whether `$count`/`$expand` compose against a location's `workorders` navigation property has never been tested live. Needs its own verification spike before it can even be scoped, unlike everything above.
- **Rate-limit-aware errors for loop callers** (added 2026-09-20; spike 2026-10-12 saw no 429 at 16 requests, so **not justified yet**; Executor already returns `{ok:false, error:{code,message,status,retryable}}` that a script can catch) — scripts in a code-mode sandbox loop fast and will hit the ~20 req/min limit; blocked attempts extend the window. Make the 429 machine-readable (e.g. `retryAfterMs` in the structured error) so a script can sleep instead of hammering; optionally a small in-process throttle (~18/min). **Touches the "retry/backoff engineering" out-of-scope item — needs Zac's explicit go-ahead before building.** Only worth doing if the spike shows real 429s.
- **README/ARCHITECTURE section "Using with code-mode gateways"** (added 2026-09-20; spike done, observed gotchas are in the Executor spike entry under Shipped; write only if gateway use becomes real) — how to register with Executor, the rate-limit caveat, and that credentials stay in the local env. Write after the spike so it records observed behavior.
- **Clearer error mapping** (added 2026-09-18) — friendly, actionable messages for the 302 auth failure, 429 and the ambiguous-route 500s, so the LLM sees more than a raw status. The 302 and bad-password auth messages already shipped in v0.5.1; this covers 429 and the 500s.
- **`npx` / npm publish** (added 2026-09-18) — install without clone and build. Pairs with the shipped credential docs (v0.5.1); the README install path would simplify.
- **Explicit log out / log in** (added 2026-09-18, idea only, likely conflicts with scope, see below) — a way for a user to end their session and be required to authenticate again. Today there is no session concept: `SC_*` credentials live in the MCP server's env, and the access token sits in an in-memory `tokenCache` that is silently re-fetched by password grant whenever it's empty or expiring. So a "log out" tool that just clears the cache would be a no-op in practice (the next call re-authenticates from env). A real log out means credentials are *not* baked into env, i.e. the server accepts them at runtime (a `login` tool or prompt) and forgets them on `logout`. That touches out-of-scope items (multi-tenant, persistent/rotated credential storage, interactive flows) and puts a password through the LLM/tool-call path, a security tradeoff. Simpler alternatives to consider first: shorten the token lifetime the cache trusts, or document `claude mcp remove` as the log-out path. **Switching users** (same family, added 2026-09-18): changing which SB2 user the server acts as has the same answer today, which is to change `SC_USERNAME`/`SC_PASSWORD` via `claude mcp remove` + `add` and restart, since one process holds one identity for its whole life. Runtime user switching needs the same runtime-credentials change as log in/out. It also matters for correctness, not just convenience: SB2 scopes visible work orders and locations by user, so results change with identity. Any switching design must clear `tokenCache` on switch so a stale token from the previous user is never reused. A cheaper alternative is registering two MCP entries (e.g. `sc-workorders-userA`, `sc-workorders-userB`), each with its own env, which needs no code change and is worth documenting. The documented workarounds (README "Changing credentials or users") shipped in v0.5.1; the runtime version below is still unbuilt. Needs an explicit go-ahead from Zac before building.


### Someday — real, but currently unverifiable or low-signal

- **`search_invoices`** (parked 2026-10-14 after a live probe; was #1 Now, aiwork task swmb1) — not buildable or verifiable today. `GET /v3/odata/invoices` returns 0 rows for everything, including `Id eq 175688826`, a known invoice (also tried `Number`, `Status`, `WoTrackingNumber`, `InvoiceDate`, `$orderby`, `$expand`); `Invoice/Id|Status|Number|InvoiceBalance` filters on `/workorders` also return 0; `ProviderId`/`LocationId` are not invoice properties (HTTP 400); `/v3/invoices` list 500s; `/v3/odata/invoices({id})` 500s (ambiguous route). The sandbox also has almost no invoices: 0 of the 50 newest and 0 of 6 `COMPLETED` work orders have one, and `INVOICED` matches 0 work orders; the only known invoice is a hand-made `OPEN` test record with total 0. What works: `GET /v3/invoices/{id}` (82 fields) and `$expand=Invoice` on a work order. Because of that the `Id eq {id}` helper extraction did not happen either (no second use). Revisit when the sandbox has real invoices or ServiceChannel fixes the list route; a by-id `get_invoice` on `/v3/invoices/{id}` is the buildable part (see Later > Invoice detail). `Currency` variation is unchecked: no list to compare across.
- **`search_proposals` / `search_rfps`** — both endpoints confirmed live and callable, but this sandbox has **zero** real records for either, so only "the endpoint responds" is verified — filter mechanics are still unconfirmed. Strategically interesting (the natural technical seed of the initiative's "Assists" tier — draft-first proposal/invoice review, per the Eng Plan docs) but not actionable until real data exists to verify against, or test fixtures get created deliberately.
- **Weather events on a work order** (`$expand=WeatherEvent`, confirmed live, null-safe) — plausible relevance for storm-driven work-order surge analysis; no request behind it yet.
- **Technician/vehicle directory** (`/v3/odata/trucks`, confirmed live with real data) — likely outside this project's FM-triage scope; kept for completeness only. Candidate for deletion from this backlog if nothing surfaces a real use case by the next review.
- **Recall / repeat-visit chain** (added 2026-10-12) — `RecallWorkOrder`, `ReassignedRecallWorkOrder` and `LinkedWorkOrders` are declared, but `RecallWorkOrder eq true` returns HTTP 400 and the field is empty on all 50 sampled rows. Strong FM-triage idea (repeat failures), unbuildable until the sandbox has data and the right filter syntax is found.
- **Work order `Labels`, `IssueTicketInfo`, `Currency`** (added 2026-10-12) — declared navigation properties, not probed.
- **MCP `prompts` for the demo scenarios** (added 2026-10-12) — expose `DEMOS.md` scenarios as server prompts. Cosmetic; no request behind it.
- **In-memory TTL cache for the trades directory** (added 2026-10-12) — `count_work_orders groupBy: trade` spends one request per call listing trades. Previously declined as state (see Tech Debt > Open); listed only so the trade-off is recorded.
- **`includeActivities` on `get_work_order_context`** (added 2026-10-12) — a third request for check-in/out history. Skipped: `get_work_order_activities` already covers it.

## Planned

_(nothing currently queued for a specific next version)_

## Shipped

### Spike: code-mode gateway (Executor v1.6.10), 2026-10-12
No server changes. sc-workorders registered in Executor as a stdio integration; same question run headless (`claude -p`, Sonnet) direct vs through Executor's `execute` tool. Question: first N open HVAC work orders, notes for each, one line per WO. One run per cell, so treat as indicative; cache effects swing cost by tens of percent.

| Run | Turns | Wall | Cost | Server API requests |
|---|---|---|---|---|
| N=5 direct | 8 | 23.6s | $0.49 | 6 |
| N=5 Executor | 9 | 45.5s | $0.42 | 6 |
| N=15 direct | 18 | 26.5s | $0.34 | 16 |
| N=15 Executor | 10 | 60.1s | $0.52 | 18 (2 extra) |

- **Verdict: composition did not pay at this size.** Notes are ~75 tokens each, so direct calls put only ~1.4k tokens of tool results in context at N=5; Executor spent 4-5 extra turns on discovery (`skills`, `tools.search`, schema reads, a failed script). Revisit with large intermediates (paged result sets, long note histories), where the gap should flip.
- **429:** none in any run (16-18 requests in under a minute). Not a reason to build throttling yet.
- **`structuredContent` is surfaced and typed** (generated TS comes from `outputSchema`); scripts read `result.data.structuredContent.<field>`, not `result.data.<field>`. Errors come back as `{ok:false,error}` values.
- **Gotchas:** (1) a stdio integration does not inherit the host env; pass `SC_*` via the integration `env`, and Executor stores them in its own local store, outside this repo. (2) Calling a tool with a wrong input name (`id` instead of `workOrderId`) returns `ok:false`; the first Executor run swallowed it and reported 0 notes for every WO. A prompt telling the model never to swallow errors fixed it. (3) The first run issued 3 identical searches, spending rate-limit budget. (4) The daemon binds `localhost` (not 127.0.0.1) and needs a bearer token over HTTP; the stdio form `executor mcp` avoids both.
- **Metrics caveat:** `apiCalls` is a global counter delta, so parallel tool calls inflate it (direct N=5 logged 3,2,2,2,1 for 6 real requests). Totals are right, per-call values are not when calls overlap.
- **`get_work_order_context` vs 3 separate calls** (WO 355703118, cold): 1 call / 2 API requests / 5.7s / ~956 est tokens vs 3 calls / 3 requests / 7.0s / ~902 est tokens. Saves a request and a round trip; tokens are a wash.

### v0.9.1 (2026-10-04)
- `outputSchema` on all 9 tools. Item schemas are Zod, co-located with each `toCompact*` mapper (the `Compact*` types are now `z.infer` of them); list wrappers live next to the registrations. The SDK validates every result against them. `search_work_orders` has optional `count`/`hasMore`/`workOrders` because `countOnly` returns just `{ totalCount }`. Unit check parses sparse mapper output against every schema; all 9 tools verified live over stdio.
- Environment guard: startup log line `sc-workorders-mcp running via stdio (API: <host>)`, host only.
- Fixed the `package-lock.json` version drift (it said 0.7.0); package.json, lockfile and server now all say 0.9.1.

### v0.9.0 (2026-10-04)
- More `search_work_orders` filters (also accepted by `count_work_orders`): `tradeId`, `categoryId`, `priority` (display string, exact, case-insensitive), `description` (`contains`, case-insensitive) and `locationName` (`contains(Location/Name,...)`, one request, no `search_locations` hop). Whitelisted in `buildFilter`; one new live check (`test.ts` 15) and a unit assertion. Findings: `PriorityId` is null on every sandbox work order, so the filter is on the `Priority` string instead of an ID; the earlier `Description` probe returned 0 only because the term wasn't present, `contains` works. (v0.8.0, `locationName` on results, is in git history only.)

### v0.7.0 (2026-09-23)
- `get_work_order_context` — work order + provider + invoice + assets in one request, plus notes: 2 API requests instead of 3. A throttled notes request returns the rest with `notes: null, notesTruncated: true`. Live-verified (`npm test`). Measured 2026-10-12 (see the Executor spike entry): saves one request and a round trip, tokens roughly equal.

### v0.6.0 (2026-09-18)
- Built-in call metrics — opt-in via `SC_METRICS_FILE`, one JSONL record per tool call: `{ts, tool, ms, apiCalls, bytes, estTokens, error}`. Wired in one place by wrapping `server.registerTool`; off by default and zero overhead when off. `estTokens` is `bytes / 4`, an estimate. Verified end to end over stdio; first real numbers: `countOnly` ~6 tokens vs ~930 for a 5-row search page.

### v0.5.1 (2026-09-18)
- Credential onboarding and rotation, docs and diagnostics only (no new auth model). `npm run check-auth` verifies credentials end to end; README gains "Getting credentials" and "Changing credentials or users" (rotate = update `.env`, check-auth, `claude mcp remove`/`add`, restart; log out = `claude mcp remove`; switch users = two named MCP entries); auth failures now name the variables to fix. Probed the token endpoint live: wrong username/password is `HTTP 400 "invalid credentials"`, wrong client ID or secret is the `302` (indistinguishable). Also fixed the README's stale tool list.

### v0.5.0 (2026-09-18)
- `count_work_orders` — new tool, counts work orders grouped by `status`, `trade` or `category` with the same filters as `search_work_orders`. `$apply=groupby` is unsupported (HTTP 400), so it composes one `$top=0` count per value: trades come from the trades directory, status/category values are discovered by "peeling" (fetch one row excluding values seen so far, count it, repeat), which found `INVOICED` among the statuses. Returns `{totalCount, groups, other, truncated}`. Live-verified (`test.ts` check 15: HVAC by status, `other: 0`).
- Found while building: the API's real rate limit is ~20 requests/min, not the 40 in the 429 message, and `Retry-After` is an HTTP date. The grouping tool runs under a 15-request budget and returns partial counts on a 429, so `groupBy: "trade"` over the full dataset is truncated (13 of 22 trades); narrowing the filters gets them all. Also fixed the 429 error text, which appended `s` to that date.

### v0.4.1 (2026-09-18)
- `countOnly` flag on `search_work_orders` — returns just `{ totalCount }` via `$top=0&$count=true` with the same filters, no `$select`/`$expand`. Live-verified before building (HTTP 200, `@odata.count: 1368` for `Trade eq 'HVAC'`, empty `value`); one new live check in `test.ts` (now 14). Also recorded that `$apply=groupby` is unsupported (HTTP 400) in `ARCHITECTURE.md`.

### v0.4.0 (2026-09-18)
- `get_work_order_assets` — new tool, `$expand=Assets` on the single-item work-order endpoint, capped at 50 via nested `$top` inside `$expand` (a real, working server-side cap on this endpoint, unlike the list endpoint — see `ARCHITECTURE.md` quirks). Response reports `{count, totalCount, truncated, assets}`, reusing `search_work_orders`' `totalCount`/`hasMore`-style shape against the work order's own `AssetCount` field.
- `get_work_order_activities` — new tool, sub-resource path `/workorders({id})/workactivities` (same broken-`$expand`/working-sub-resource pattern as notes). Real `WorkActivity` shape confirmed live: check-in/check-out times, technician (from nested `User.FullName`), resolution code, work type, tech count.
- Resolves the "no response-size/truncation safeguard" Tech Debt item (see Tech Debt > Resolved below) — solved by reusing the existing `totalCount`/`hasMore` pattern against a real cap, not a new mechanism.

### v0.3.0 (2026-09-16)
- Surface invoice info on work orders — `invoice: {id, number, status, total, balance, invoiceDate, paidDate} | null` added to both `search_work_orders` and `get_work_order` via `$expand=Invoice`
- `search_trades` — new tool, resolves a fuzzy trade name to the exact string `search_work_orders`' `trade`/`category` filters need
- Bonus finding while shipping the above: nested `$expand(...)($select=...)` works on this API — `Provider` is now also trimmed down to only its used fields (not just `Invoice`), further cutting payload size beyond the outer `$select` alone

### v0.2.0 (2026-09-16)
- Expose `tradeId`, `priorityId`, `category`, `categoryId` on both work-order tools (already fetched from the API, previously unmapped)
- `category` filter on `search_work_orders`
- `scheduledDate`/`completedDate` range filters on `search_work_orders` (in addition to the existing `createdDate` filter)
- Sorting (`sortBy`/`sortOrder`) on `search_work_orders`
- Pagination (`offset`, with computed `totalCount`/`hasMore`) on `search_work_orders`
- `get_work_order_notes` — new tool for a work order's note history

### v0.1.0 (2026-09-16)
- Initial prototype: `search_work_orders`, `get_work_order` (status, trade, location, priority, dates)
- `search_locations` — resolve a location name/address to its `locationId`
- Provider assignment (`provider: {id, name, contactName, phone, email}`) on both work-order tools, plus `providerId`/`providerName` filtering

## Rejected

- **`search_providers`** (a location-style provider directory) — rejected 2026-09-16. No standalone provider list/search endpoint exists on ServiceChannel's API: `/v3/odata/providers` 500s (ambiguous controller action), `/v3/odata/detailedProviders` 404s despite being declared in `$metadata`, and expanding providers through a location also 500s. The only way to see provider data is the existing per-work-order `$expand=Provider`. See `ARCHITECTURE.md`'s API quirks section. **Don't re-attempt without a documented change on ServiceChannel's side.**
- **`search_assets`/`get_asset`** (a standalone asset directory) — rejected 2026-09-16, discovered during the same research pass that found `search_providers`' dead end. `/v3/odata/assets?$top=1` returns `HTTP 500` with the identical ambiguous-controller-action error shape (`"Multiple actions were found that match the request: GetAsset, GetWOAssetTags, GetBrands..."`). Same root cause pattern as providers. Assets **are** still reachable, just not as their own directory — see the `$expand=Assets` item above, which works fine because it's scoped through a work order rather than being a bare collection GET.

- **Built-in `execute`/sandbox tool in this server** (code mode inside the server) — rejected 2026-09-20. Arbitrary code execution undermines the whitelist-only safety boundary (`buildFilter`/`buildOrderBy`), adds sandbox/monitoring ops burden (Anthropic's own stated caveat), and most sandboxes need remote/HTTP transport, which is out of scope. Gateways like Executor already provide that layer around this server. Revisit only if a gateway can't be used.
- **Batch inputs (`workOrderIds[]`) on notes/activities/assets** — rejected 2026-09-20. Each is a separate sub-resource GET, so batching saves no API calls; the ~20 req/min rate limit, not token count, is the bottleneck. Code mode already removes the token cost of looping.

## Tech Debt

Not new capability — maintenance/quality items surfaced while building or researching this project. Same lifecycle as feature items (add, update, remove) but tracked separately since "should we fix this" is a different question from "should we build this."

### Resolved (2026-10-04)

- **~~`package-lock.json` version drift.~~** Lockfile said 0.7.0 while `package.json` and the server said 0.9.0. Fixed in v0.9.1 with `npm install --package-lock-only`. Bump `package.json`, the lockfile (re-run that command) and the version string in `src/index.ts` together.

### Resolved (2026-09-18)

- **~~No response-size/truncation safeguard.~~** Resolved by `get_work_order_assets` (v0.4.0). `$expand=Assets($top=50)` on the single-item work-order endpoint genuinely caps the returned array server-side (confirmed live: `$top=10` returned exactly 10 of a real `AssetCount` of 60) — and the work order already carries `AssetCount` as a plain field, so the response reuses `search_work_orders`' existing `totalCount`/`hasMore`-style shape (`{count, totalCount, truncated}`) rather than inventing a new mechanism. Note this only applies to the single-item endpoint — the list endpoint's `$expand=Assets` silently caps at 50 regardless of requested `$top`, a separate quirk documented in `ARCHITECTURE.md`.

### Resolved (2026-09-16)

- **~~Generalize the parens-broken/`$filter=Id eq` workaround.~~** Re-scoped on inspection: it's currently used at exactly one real call site (`buildLocationFilter`) — `providers` has no working directory at all (see Rejected), so there's no second live implementation to deduplicate against yet. Building a shared helper for one call site would be an abstraction with a single implementation. Resolved by decision instead: left a code comment at that call site pointing future entities (invoices, once built) at the same one-line pattern. Actually extract a helper the second time it's needed, not before.
- **~~No `$select` on any existing call.~~** Done. `WORKORDER_SELECT`/`LOCATION_SELECT`/`NOTE_SELECT`/`TRADE_SELECT` constants added in `sc-client.ts`, co-located with each `toCompact*` mapper, wired into every `apiFetch` call in both `src/index.ts` and `test.ts`. Measured a real 59% payload reduction on a 5-row work-order page (16,113 → 6,532 bytes) before shipping. Extended further in v0.3.0: `WORKORDER_EXPAND` now uses nested `$expand(...)($select=...)` to trim `Provider`/`Invoice` down to only their used fields too, not just the outer work-order object.
- **~~`test.ts` fixture-override inconsistency.~~** Resolved by decision, not by code: added a header comment in `test.ts` explaining that hardcoded sandbox fixtures are deliberate (stable enough records that env-var plumbing per fixture would be pure ceremony), and why `SC_TEST_WORKORDER_ID` is the one exception (it needs *some* real ID, not a specific one with specific data).
- **~~No linting/formatting config.~~** Done. ESLint 10 (`typescript-eslint` recommended) + Prettier 3 added, `npm run lint`/`format`/`format:check` scripts, both wired into CI. `@typescript-eslint/no-explicit-any` explicitly disabled (documented reason in `eslint.config.js`) rather than flagging the ~9 intentional `any` usages on raw API responses. `printWidth: 120` (not the 80 default) to keep the one-time adoption reformat low-churn against this codebase's existing style.
- **~~No CI coverage of the live-dependent logic.~~** Partially resolved: the *pure* logic (filter/orderby builders, response mappers) now has real coverage in CI via the new `unit.test.ts` + `npm run test:unit`, using placeholder env vars so no real credentials are needed. What's still true and unresolved: the *live* API-calling logic (`apiFetch`, `fetchToken`, and real filtering/sorting/pagination behavior against real data) still can't run in CI without exposing real credentials, and still doesn't.

### Open
- **Group-by counts over the full dataset are budget-limited.** With ~20 requests/min, `count_work_orders` by trade covers 13 of 22 trades unfiltered. Possible fixes if it matters: cache the per-value counts briefly in memory, or add a `groups` input to pick which values to count. Deliberately not built: caching is state, and narrowing filters already works.
- **Fixture drift.** The SB2 sandbox re-syncs from production weekly, but `test.ts` and `DEMOS.md` hardcode specific records (355703118, 354456038, 357049342, trade `HVAC`, a 60-asset work order). A re-sync that drops one fails a check for a reason that looks like a bug. Cheapest fix: a `npm run check-fixtures` that GETs each hardcoded id and prints which are gone (about 6 requests). Promoted to Next 2026-10-12.
- **`test.ts` as one growing file.** Less urgent than it was — the pure-function tests split out into their own `unit.test.ts` this session, so `test.ts` itself only grows with genuinely new *live* behavior now. Now at 16 checks; revisit a split-by-tool convention if it approaches ~15–20.
