# sc-workorders-mcp — Feature Backlog

Living list of proposed, planned, shipped, and rejected features — plus tracked tech debt — for this project. Kept up to date by whoever's working on this repo — directly, or via the `sc-workorders-feedback` skill, which reads and updates this file as part of its normal workflow. Add ideas here as they come up, even ones not being built yet; move them between sections as their status changes; delete anything that's no longer relevant rather than letting it go stale.

## Proposed

Batch added 2026-09-16, live-verified against the real SB2 `$metadata` and API before being listed here (per this project's standing discipline — see `ARCHITECTURE.md`'s API quirks). Each item notes its evidence so a future session doesn't have to re-derive it.

**Prioritized 2026-09-16** on three axes: confirmed feasibility (live-verified with real data > callable but untested against data > design unverified), value against triage questions this tool already exists to answer, and effort relative to patterns already in the codebase. This ordering isn't fixed — re-prioritize whenever new evidence (real proposal/RFP data lands in the sandbox, a location-rollup spike gets run, etc.) changes any of those three inputs.

### Now

_(empty — both items shipped in v0.3.0, see Shipped below)_

### Next — proven with real data, more design surface than "Now"

- **`get_work_order_assets`** — via `$expand=Assets` (confirmed live with real data — a work order with `AssetCount: 60` returned full nested asset objects). A dedicated tool, mirroring `get_work_order_notes`'s "separate call, only pay for it when asked" tradeoff. Behind invoice/trades in priority only because a 60-item list makes it the first tool that actually needs the still-open response-size/truncation tech debt item — sequence that decision alongside this, not after shipping it blind.
- **`get_work_order_activities`** — via the sub-resource path `/workorders({id})/workactivities` (confirmed live, `HTTP 200`, following the exact same broken-`$expand`/working-sub-resource pattern as notes). Ranked just behind assets because the one work order tested had zero activity records — the path works, but real field shapes/value are less proven than notes or assets were.

### Later — valuable, but bigger scope or sequenced behind "Now"/"Next"

- **`get_work_order_context`** (composite tool bundling a work order + notes + assets + invoice in one call) — every underlying piece is confirmed working, but it's compositing tools that don't fully exist yet (assets, and ideally activities). Build this after its parts ship, not before — sequencing, not a feasibility question. Still has the open truncation design question from the assets item above.
- **`search_invoices`** (+ get-by-id via the `$filter=Id eq {id}` workaround, since the parens form is confirmed broken the same way `locations({id})` is) — real live data confirmed, but this is a bigger lift (a whole new entity/tool) than just surfacing invoice data on work orders (see "Now" above). Worth building once it's clear WO-embedded invoice data isn't enough on its own — invoice-first queries ("show me unpaid invoices") are a different shape of question than work-order-first ones. This would be the second real use of the parens-broken workaround — extract the shared helper mentioned in the Tech Debt entry when this ships.
- **Location-level rollup** (e.g. open-work-order count per location) — genuinely unverified, not just lower-value: whether `$count`/`$expand` compose against a location's `workorders` navigation property has never been tested live. Needs its own verification spike before it can even be scoped, unlike everything above.

### Someday — real, but currently unverifiable or low-signal

- **`search_proposals` / `search_rfps`** — both endpoints confirmed live and callable, but this sandbox has **zero** real records for either, so only "the endpoint responds" is verified — filter mechanics are still unconfirmed. Strategically interesting (the natural technical seed of the initiative's "Assists" tier — draft-first proposal/invoice review, per the Eng Plan docs) but not actionable until real data exists to verify against, or test fixtures get created deliberately.
- **Weather events on a work order** (`$expand=WeatherEvent`, confirmed live, null-safe) — plausible relevance for storm-driven work-order surge analysis; no request behind it yet.
- **Technician/vehicle directory** (`/v3/odata/trucks`, confirmed live with real data) — likely outside this project's FM-triage scope; kept for completeness only. Candidate for deletion from this backlog if nothing surfaces a real use case by the next review.

## Planned

_(nothing currently queued for a specific next version)_

## Shipped

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

### Resolved (2026-09-16)

- **~~Generalize the parens-broken/`$filter=Id eq` workaround.~~** Re-scoped on inspection: it's currently used at exactly one real call site (`buildLocationFilter`) — `providers` has no working directory at all (see Rejected), so there's no second live implementation to deduplicate against yet. Building a shared helper for one call site would be an abstraction with a single implementation. Resolved by decision instead: left a code comment at that call site pointing future entities (invoices, once built) at the same one-line pattern. Actually extract a helper the second time it's needed, not before.
- **~~No `$select` on any existing call.~~** Done. `WORKORDER_SELECT`/`LOCATION_SELECT`/`NOTE_SELECT`/`TRADE_SELECT` constants added in `sc-client.ts`, co-located with each `toCompact*` mapper, wired into every `apiFetch` call in both `src/index.ts` and `test.ts`. Measured a real 59% payload reduction on a 5-row work-order page (16,113 → 6,532 bytes) before shipping. Extended further in v0.3.0: `WORKORDER_EXPAND` now uses nested `$expand(...)($select=...)` to trim `Provider`/`Invoice` down to only their used fields too, not just the outer work-order object.
- **~~`test.ts` fixture-override inconsistency.~~** Resolved by decision, not by code: added a header comment in `test.ts` explaining that hardcoded sandbox fixtures are deliberate (stable enough records that env-var plumbing per fixture would be pure ceremony), and why `SC_TEST_WORKORDER_ID` is the one exception (it needs *some* real ID, not a specific one with specific data).
- **~~No linting/formatting config.~~** Done. ESLint 10 (`typescript-eslint` recommended) + Prettier 3 added, `npm run lint`/`format`/`format:check` scripts, both wired into CI. `@typescript-eslint/no-explicit-any` explicitly disabled (documented reason in `eslint.config.js`) rather than flagging the ~9 intentional `any` usages on raw API responses. `printWidth: 120` (not the 80 default) to keep the one-time adoption reformat low-churn against this codebase's existing style.
- **~~No CI coverage of the live-dependent logic.~~** Partially resolved: the *pure* logic (filter/orderby builders, response mappers) now has real coverage in CI via the new `unit.test.ts` + `npm run test:unit`, using placeholder env vars so no real credentials are needed. What's still true and unresolved: the *live* API-calling logic (`apiFetch`, `fetchToken`, and real filtering/sorting/pagination behavior against real data) still can't run in CI without exposing real credentials, and still doesn't.

### Open

- **No response-size/truncation safeguard.** Still not a problem today — no shipped tool currently produces unbounded output. Explicitly **not** built yet (deliberately deferred, not missed): the `get_work_order_assets`/`get_work_order_context` items in Proposed above are what will actually need this (a work order with 60 assets was found live). Build it when one of those ships, not speculatively ahead of them.
- **`test.ts` as one growing file.** Less urgent than it was — the pure-function tests split out into their own `unit.test.ts` this session, so `test.ts` itself only grows with genuinely new *live* behavior now. Still fine at 11 checks; revisit a split-by-tool convention if it approaches ~15–20.
