# sc-workorders-mcp — Feature Backlog

Living list of proposed, planned, shipped, and rejected features — plus tracked tech debt — for this project. Kept up to date by whoever's working on this repo — directly, or via the `sc-workorders-feedback` skill, which reads and updates this file as part of its normal workflow. Add ideas here as they come up, even ones not being built yet; move them between sections as their status changes; delete anything that's no longer relevant rather than letting it go stale.

## Proposed

Batch added 2026-09-16, live-verified against the real SB2 `$metadata` and API before being listed here (per this project's standing discipline — see `ARCHITECTURE.md`'s API quirks). Each item notes its evidence so a future session doesn't have to re-derive it.

**Invoices**
- `search_invoices` — filter by status/date/provider/work order. Standalone `/v3/odata/invoices` confirmed live (`HTTP 200`, real data present in this sandbox).
- Get a single invoice by ID — `/v3/odata/invoices({id})` (parens form) confirmed **broken** (`HTTP 500`, same ambiguous-controller-action bug as `locations`); use the `$filter=Id eq {id}` workaround instead (confirmed working, same pattern as `buildLocationFilter` — see the comment at that call site in `sc-client.ts`). This will be the second real use of that pattern — worth extracting into a shared helper when this ships, per the Tech Debt entry on that decision.
- Surface invoice info directly on a work order via `$expand=Invoice` — confirmed live and null-safe (returns `Invoice: null` cleanly when none exists) on both `get_work_order` and `search_work_orders`.

**Assets**
- Expose a work order's attached assets via `$expand=Assets` — confirmed live with real data (a work order with `AssetCount: 60` returned full nested asset objects). Likely a dedicated `get_work_order_assets` tool rather than a field bolted onto `get_work_order`, mirroring `get_work_order_notes`'s pattern — a 60-item asset list argues for the same "separate call, only pay for it when asked" tradeoff already made for notes. Response-size management (see Tech Debt) matters here more than anywhere else in the project so far.
- ~~`search_assets`/`get_asset` as a standalone directory~~ — **not buildable**, see Rejected below.

**Proposals & RFPs** (this is the natural technical seed of the initiative's "Assists" tier — draft-first proposal/invoice review, per the Eng Plan docs)
- `search_proposals` — standalone `/v3/odata/proposals` confirmed live (`HTTP 200`), but this sandbox currently has **zero** proposal records, so only "the endpoint responds" is verified — filter mechanics against real data are still unconfirmed. Re-verify against real records before shipping.
- `search_rfps` — same situation: `/v3/odata/rfps` confirmed live (`HTTP 200`), zero live records to test filters against.

**Trades — closes a real, already-felt gap**
- `search_trades` — standalone `/v3/odata/trades` confirmed live with real data (e.g. `"GENERAL MAINTENANCE"`). Right now `search_work_orders`'s `trade`/`category` filters require the caller to already know the exact string with no way to discover valid values first — this plays the same role for `trade` that `search_locations` already plays for `locationId`.

**Work order activity/timeline**
- `get_work_order_activities` — via the sub-resource path `/workorders({id})/workactivities` (confirmed live, `HTTP 200`; empty for the one work order tested, but the path itself works). Note `$expand=workactivities` is **broken** the same way `$expand=notes` is (`"has no supported translation to SQL"`) — this needs the sub-resource path, exactly like notes. Should follow `get_work_order_notes`'s pattern closely enough that the two might share a helper.

**Composite/workflow tools** (see the orchestrator question, addressed in-thread rather than as its own backlog item — the short version: no meta "which tool do I call" tool, that's the calling LLM's job; the right pattern is an ordinary tool that bundles a few already-working calls for a common multi-entity question)
- `get_work_order_context` — one call returning a work order + its notes + its assets + its invoice together, for the common "give me the full picture on WO X" ask instead of 3–4 separate tool calls. Every underlying call is already confirmed working; the open design question is response-size handling for a work order with many assets (see the 60-asset example above).
- Location-level rollup (e.g. open-work-order count per location) — **not yet verified**: whether `$count`/`$expand` compose against a location's `workorders` navigation property is untested. Check that live before designing the tool, not after.

**Low-priority / speculative** — found live during this research pass, listed for completeness since the ask was explicitly to look beyond work orders, but no concrete use case behind either yet
- Weather events on a work order (`$expand=WeatherEvent`, confirmed live, null-safe) — plausible relevance for storm-driven work-order surge analysis; no request behind it yet.
- Technician/vehicle directory (`/v3/odata/trucks`, confirmed live with real data) — likely outside this project's FM-triage scope; noted only because it exists.

## Planned

_(nothing currently queued for a specific next version)_

## Shipped

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

### Resolved (2026-09-16)

- **~~Generalize the parens-broken/`$filter=Id eq` workaround.~~** Re-scoped on inspection: it's currently used at exactly one real call site (`buildLocationFilter`) — `providers` has no working directory at all (see Rejected), so there's no second live implementation to deduplicate against yet. Building a shared helper for one call site would be an abstraction with a single implementation. Resolved by decision instead: left a code comment at that call site pointing future entities (invoices, once built) at the same one-line pattern. Actually extract a helper the second time it's needed, not before.
- **~~No `$select` on any existing call.~~** Done. `WORKORDER_SELECT`/`LOCATION_SELECT`/`NOTE_SELECT` constants added in `sc-client.ts`, co-located with each `toCompact*` mapper, wired into every `apiFetch` call in both `src/index.ts` and `test.ts`. Measured a real 59% payload reduction on a 5-row work-order page (16,113 → 6,532 bytes) before shipping.
- **~~`test.ts` fixture-override inconsistency.~~** Resolved by decision, not by code: added a header comment in `test.ts` explaining that hardcoded sandbox fixtures are deliberate (stable enough records that env-var plumbing per fixture would be pure ceremony), and why `SC_TEST_WORKORDER_ID` is the one exception (it needs *some* real ID, not a specific one with specific data).
- **~~No linting/formatting config.~~** Done. ESLint 10 (`typescript-eslint` recommended) + Prettier 3 added, `npm run lint`/`format`/`format:check` scripts, both wired into CI. `@typescript-eslint/no-explicit-any` explicitly disabled (documented reason in `eslint.config.js`) rather than flagging the ~9 intentional `any` usages on raw API responses. `printWidth: 120` (not the 80 default) to keep the one-time adoption reformat low-churn against this codebase's existing style.
- **~~No CI coverage of the live-dependent logic.~~** Partially resolved: the *pure* logic (filter/orderby builders, response mappers) now has real coverage in CI via the new `unit.test.ts` + `npm run test:unit`, using placeholder env vars so no real credentials are needed. What's still true and unresolved: the *live* API-calling logic (`apiFetch`, `fetchToken`, and real filtering/sorting/pagination behavior against real data) still can't run in CI without exposing real credentials, and still doesn't.

### Open

- **No response-size/truncation safeguard.** Still not a problem today — no shipped tool currently produces unbounded output. Explicitly **not** built yet (deliberately deferred, not missed): the `get_work_order_assets`/`get_work_order_context` items in Proposed above are what will actually need this (a work order with 60 assets was found live). Build it when one of those ships, not speculatively ahead of them.
- **`test.ts` as one growing file.** Less urgent than it was — the pure-function tests split out into their own `unit.test.ts` this session, so `test.ts` itself only grows with genuinely new *live* behavior now. Still fine at 9 checks; revisit a split-by-tool convention if it approaches ~15–20.
