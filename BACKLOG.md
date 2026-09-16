# sc-workorders-mcp — Feature Backlog

Living list of proposed, planned, shipped, and rejected features for this project. Kept up to date by whoever's working on this repo — directly, or via the `sc-workorders-feedback` skill, which reads and updates this file as part of its normal workflow. Add ideas here as they come up, even ones not being built yet; move them between sections as their status changes; delete anything that's no longer relevant rather than letting it go stale.

## Proposed

_(none yet — add new ideas here as they come up, one bullet each, with enough context that a future session can evaluate them cold)_

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
