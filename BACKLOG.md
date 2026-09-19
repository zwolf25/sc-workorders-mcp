# sc-workorders-mcp — Feature Backlog

Living list of proposed, planned, shipped, and rejected features — plus tracked tech debt — for this project. Kept up to date by whoever's working on this repo — directly, or via the `sc-workorders-feedback` skill, which reads and updates this file as part of its normal workflow. Add ideas here as they come up, even ones not being built yet; move them between sections as their status changes; delete anything that's no longer relevant rather than letting it go stale.

## Proposed

Batch added 2026-09-16, live-verified against the real SB2 `$metadata` and API before being listed here (per this project's standing discipline — see `ARCHITECTURE.md`'s API quirks). Each item notes its evidence so a future session doesn't have to re-derive it.

**Prioritized 2026-09-16** on three axes: confirmed feasibility (live-verified with real data > callable but untested against data > design unverified), value against triage questions this tool already exists to answer, and effort relative to patterns already in the codebase. This ordering isn't fixed — re-prioritize whenever new evidence (real proposal/RFP data lands in the sandbox, a location-rollup spike gets run, etc.) changes any of those three inputs.

### Now

Re-prioritized 2026-09-18 (same three axes as above; two items were probed live to firm up feasibility first).

_(empty — count-only mode shipped in v0.4.1, see Shipped below)_

### Next

Ordered by value against the triage questions this tool exists to answer.

- **`get_work_order_context`** (composite tool bundling a work order + notes + assets + invoice in one call) — every underlying piece now exists and is confirmed working (`get_work_order`, `get_work_order_notes`, `get_work_order_assets`, invoice-on-work-order). Promoted from Later now that its dependencies shipped in v0.4.0 — no more sequencing blocker, just the build itself. The truncation question is already resolved (`get_work_order_assets`'s `{count, totalCount, truncated}` shape), so this just needs to compose the existing calls.
- **More `search_work_orders` filters** (added 2026-09-18, unverified) — `contains(Description,'x')` text search (`contains(Description,...)` is accepted, HTTP 200, but the one probe returned 0 matches, so match behavior is still unconfirmed; retry with a term known to appear); `priority`, `tradeId` and `categoryId` filters (the IDs are already returned but can't be filtered on, and `tradeId` would skip the exact-string trade lookup); `locationName`, resolved internally (today it takes `search_locations` then `search_work_orders`). Any new filter goes through the `buildFilter` whitelist.

### Later — valuable, but bigger scope or sequenced behind "Now"/"Next"

- **`search_invoices`** (+ get-by-id via the `$filter=Id eq {id}` workaround, since the parens form is confirmed broken the same way `locations({id})` is) — real live data confirmed, but this is a bigger lift (a whole new entity/tool) than just surfacing invoice data on work orders (see "Now" above). Worth building once it's clear WO-embedded invoice data isn't enough on its own — invoice-first queries ("show me unpaid invoices") are a different shape of question than work-order-first ones. This would be the second real use of the parens-broken workaround — extract the shared helper mentioned in the Tech Debt entry when this ships.
- **Location-level rollup** (e.g. open-work-order count per location) — genuinely unverified, not just lower-value: whether `$count`/`$expand` compose against a location's `workorders` navigation property has never been tested live. Needs its own verification spike before it can even be scoped, unlike everything above.
- **Clearer error mapping** (added 2026-09-18) — friendly, actionable messages for the 302 auth failure, 429 and the ambiguous-route 500s, so the LLM sees more than a raw status. The 302 and bad-password auth messages already shipped in v0.5.1; this covers 429 and the 500s.
- **Environment guard** (added 2026-09-18) — `SC_API_BASE_URL` swaps between sandbox and prod silently. A startup log line naming the environment (host only, never credentials) would prevent "which env am I querying?" confusion.
- **`npx` / npm publish** (added 2026-09-18) — install without clone and build. Pairs with the shipped credential docs (v0.5.1); the README install path would simplify.
- **Explicit log out / log in** (added 2026-09-18, idea only, likely conflicts with scope, see below) — a way for a user to end their session and be required to authenticate again. Today there is no session concept: `SC_*` credentials live in the MCP server's env, and the access token sits in an in-memory `tokenCache` that is silently re-fetched by password grant whenever it's empty or expiring. So a "log out" tool that just clears the cache would be a no-op in practice (the next call re-authenticates from env). A real log out means credentials are *not* baked into env, i.e. the server accepts them at runtime (a `login` tool or prompt) and forgets them on `logout`. That touches out-of-scope items (multi-tenant, persistent/rotated credential storage, interactive flows) and puts a password through the LLM/tool-call path, a security tradeoff. Simpler alternatives to consider first: shorten the token lifetime the cache trusts, or document `claude mcp remove` as the log-out path. **Switching users** (same family, added 2026-09-18): changing which SB2 user the server acts as has the same answer today, which is to change `SC_USERNAME`/`SC_PASSWORD` via `claude mcp remove` + `add` and restart, since one process holds one identity for its whole life. Runtime user switching needs the same runtime-credentials change as log in/out. It also matters for correctness, not just convenience: SB2 scopes visible work orders and locations by user, so results change with identity. Any switching design must clear `tokenCache` on switch so a stale token from the previous user is never reused. A cheaper alternative is registering two MCP entries (e.g. `sc-workorders-userA`, `sc-workorders-userB`), each with its own env, which needs no code change and is worth documenting. The documented workarounds (README "Changing credentials or users") shipped in v0.5.1; the runtime version below is still unbuilt. Needs an explicit go-ahead from Zac before building.

### Someday — real, but currently unverifiable or low-signal

- **`search_proposals` / `search_rfps`** — both endpoints confirmed live and callable, but this sandbox has **zero** real records for either, so only "the endpoint responds" is verified — filter mechanics are still unconfirmed. Strategically interesting (the natural technical seed of the initiative's "Assists" tier — draft-first proposal/invoice review, per the Eng Plan docs) but not actionable until real data exists to verify against, or test fixtures get created deliberately.
- **Weather events on a work order** (`$expand=WeatherEvent`, confirmed live, null-safe) — plausible relevance for storm-driven work-order surge analysis; no request behind it yet.
- **Technician/vehicle directory** (`/v3/odata/trucks`, confirmed live with real data) — likely outside this project's FM-triage scope; kept for completeness only. Candidate for deletion from this backlog if nothing surfaces a real use case by the next review.

## Planned

_(nothing currently queued for a specific next version)_

## Shipped

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

## Tech Debt

Not new capability — maintenance/quality items surfaced while building or researching this project. Same lifecycle as feature items (add, update, remove) but tracked separately since "should we fix this" is a different question from "should we build this."

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
- **`test.ts` as one growing file.** Less urgent than it was — the pure-function tests split out into their own `unit.test.ts` this session, so `test.ts` itself only grows with genuinely new *live* behavior now. Now at 13 checks; revisit a split-by-tool convention if it approaches ~15–20.
