# sc-workorders-mcp — Demo Scenarios

Prompts to run in a Claude session with this server connected, each chosen to show off specific capabilities. Kept in sync with the tool set by the `sc-workorders-feedback` skill: any change to a tool's inputs, outputs, or behavior updates the scenarios it touches, and every new tool or filter gets at least one scenario. IDs below are real records in the SB2 sandbox (the same ones `test.ts` asserts against); re-verify them if the sandbox is re-synced from production. All six scenarios were run live on 2026-09-24; counts drift with each sync, so treat numbers as illustrative.

The API throttles at ~20 requests/min, so leave a minute between scenarios and don't run them back to back.

## Coverage

| Tool | Scenarios |
|---|---|
| `search_work_orders` | 1, 2, 4 |
| `count_work_orders` | 3 |
| `get_work_order` | 5 |
| `get_work_order_notes` | 5 |
| `get_work_order_assets` | 6 |
| `get_work_order_activities` | 5 |
| `get_work_order_context` | 5, 6 |
| `search_locations` | 2 |
| `search_trades` | 2 |

## Scenarios

### 1. Triage: what is open right now?
**Say:** "Show me the 5 oldest open work orders and how many open work orders there are in total."
**Shows:** `search_work_orders` with `status`, `sortBy`/`sortOrder`, and `totalCount`/`hasMore` pagination; `countOnly` for the cheap total (~6 tokens vs ~930 for a 5-row page).

### 2. Name-to-ID resolution
**Say:** "Find work orders at the Union location in the maintenance trade."
**Shows:** chaining `search_locations` (name `Union`) and `search_trades` (name `maint`) into `search_work_orders` filters, instead of the user knowing IDs or exact trade strings.

### 3. Grouped counts and throttle handling
**Say:** "How many work orders are there in each status?"
**Shows:** `count_work_orders` with `groupBy: status` (as of 2026-09-24: OPEN, IN PROGRESS, COMPLETED, INVOICED, VOID and a blank status) and the `other`/`truncated` fields. Follow up with "…by trade" to show the partial-result behavior when the request budget or throttle cuts it short.

### 4. Vendor investigation
**Say:** "Which work orders are assigned to Fahey, and which have been completed since June?"
**Shows:** `providerName` fuzzy filter, `completedDateFrom`, and how filters compose.

### 5. Everything about one work order
**Say:** "Tell me the full story of work order 355703118: who's on it, notes, and technician activity." (Invoice variant: 357049342, which has an OPEN invoice.)
**Shows:** `get_work_order_context` returning work order + provider + invoice + assets + notes in one call (2 API requests), then `get_work_order_activities` for check-in/out history. Compare with calling `get_work_order`, `get_work_order_notes` and `get_work_order_assets` separately; `SC_METRICS_FILE` shows the request and token difference.

### 6. Big asset list and truncation
**Say:** "What equipment is tied to work order 354456038?"
**Shows:** `get_work_order_assets` / `get_work_order_context` returning 50 of 60 with `truncated: true` and the real `totalCount`. Descriptive asset fields are mostly null in the sandbox; that is the data, not a bug.

## Maintaining this file

- New or changed tool, filter, or output field: add or adjust the scenario that exercises it, and update the Coverage table.
- Removed or renamed behavior: delete or rewrite any scenario that depends on it. Don't leave stale prompts.
- Verify each new or changed scenario's prompt against the live server before committing (mind the rate limit).
