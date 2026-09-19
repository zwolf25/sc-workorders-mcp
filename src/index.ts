#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  apiFetch,
  buildFilter,
  buildLocationFilter,
  buildOrderBy,
  buildTradeFilter,
  countWorkOrdersBy,
  GROUP_BY,
  toCompactWorkOrder,
  toCompactLocation,
  toCompactNote,
  toCompactTrade,
  toCompactAsset,
  toCompactActivity,
  WORKORDER_SELECT,
  WORKORDER_EXPAND,
  LOCATION_SELECT,
  NOTE_SELECT,
  TRADE_SELECT,
  ASSET_SELECT,
  ASSET_CAP,
  ACTIVITY_SELECT,
} from "./sc-client.js";

const server = new McpServer({ name: "sc-workorders-mcp", version: "0.5.1" });

const SearchInputSchema = z
  .object({
    status: z
      .string()
      .optional()
      .describe("Work order status, e.g. 'OPEN', 'IN PROGRESS', 'COMPLETED' (case-sensitive, exact match)"),
    trade: z.string().optional().describe("Trade label, e.g. 'ALARMS', 'HVAC'"),
    locationId: z.number().int().positive().optional().describe("ServiceChannel location ID"),
    dateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Created on/after this date, YYYY-MM-DD"),
    dateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Created on/before this date, YYYY-MM-DD"),
    providerId: z.number().int().positive().optional().describe("Exact ServiceChannel provider (vendor) ID"),
    providerName: z.string().optional().describe("Fuzzy match against the assigned provider's name"),
    category: z.string().optional().describe("Work order category, e.g. 'MAINTENANCE', 'REPAIR', 'CAP-EX'"),
    scheduledDateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Scheduled on/after this date, YYYY-MM-DD"),
    scheduledDateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Scheduled on/before this date, YYYY-MM-DD"),
    completedDateFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Completed on/after this date, YYYY-MM-DD"),
    completedDateTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Completed on/before this date, YYYY-MM-DD"),
    sortBy: z.enum(["createdDate", "scheduledDate", "completedDate"]).optional().describe("Field to sort by"),
    sortOrder: z.enum(["asc", "desc"]).default("desc").describe("Sort direction (only used if sortBy is set)"),
    offset: z.number().int().min(0).default(0).describe("Number of results to skip, for paging past the first page"),
    maxResults: z.number().int().min(1).max(50).default(20).describe("Max results to return (server caps at 50)"),
    countOnly: z
      .boolean()
      .default(false)
      .describe("Return only { totalCount } for the filters, no work orders. Use for 'how many...' questions."),
  })
  .strict();

server.registerTool(
  "search_work_orders",
  {
    title: "Search Work Orders",
    description: `Search ServiceChannel work orders by status, trade, category, location, provider, and/or date range (created/scheduled/completed). Supports sorting and paging. Read-only.

Returns: { count: number, totalCount: number, hasMore: boolean, workOrders: [{ id, status: {primary, extended}, trade, tradeId, locationId, priority, priorityId, category, categoryId, description, createdDate, scheduledDate, completedDate, provider: {id, name, contactName, phone, email} | null, invoice: {id, number, status, total, balance, invoiceDate, paidDate} | null }] }

totalCount is the total number of matching work orders (not just this page); hasMore is true if offset+count < totalCount. Use offset to page through results beyond the first maxResults.

For "how many" questions set countOnly: true — returns just { totalCount } (cheaper, no work orders).`,
    inputSchema: SearchInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const filter = buildFilter(params);
    if (params.countOnly) {
      const counted = await apiFetch("/v3/odata/workorders", {
        ...(filter ? { $filter: filter } : {}),
        $top: "0",
        $count: "true",
      });
      const output = { totalCount: counted["@odata.count"] ?? 0 };
      return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
    }
    const orderBy = buildOrderBy(params.sortBy, params.sortOrder);
    const data = await apiFetch("/v3/odata/workorders", {
      ...(filter ? { $filter: filter } : {}),
      ...(orderBy ? { $orderby: orderBy } : {}),
      $select: WORKORDER_SELECT,
      $expand: WORKORDER_EXPAND,
      $top: String(params.maxResults),
      $skip: String(params.offset),
      $count: "true",
    });
    const workOrders = (data.value ?? []).map(toCompactWorkOrder);
    const totalCount = data["@odata.count"] ?? workOrders.length;
    const output = {
      count: workOrders.length,
      totalCount,
      hasMore: params.offset + workOrders.length < totalCount,
      workOrders,
    };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

const CountInputSchema = SearchInputSchema.omit({
  sortBy: true,
  sortOrder: true,
  offset: true,
  maxResults: true,
  countOnly: true,
})
  .extend({ groupBy: z.enum(GROUP_BY).describe("Field to group the counts by") })
  .strict();

server.registerTool(
  "count_work_orders",
  {
    title: "Count Work Orders",
    description: `Count ServiceChannel work orders grouped by status, trade, or category, with the same filters as search_work_orders. Read-only.

Returns: { totalCount, groups: [{ value, count }] (largest first), other, truncated }. "other" is any matches not in groups (null values, or cut off by the request budget or throttling — truncated is then true).

Costs roughly 2 API requests per distinct status/category value and 1 per trade, and the API throttles hard (~20 requests/min in practice), so grouping by trade over the whole dataset comes back truncated — narrow with filters, and don't call it repeatedly. If throttled, it returns the partial counts with truncated: true. For a single total with no breakdown use search_work_orders with countOnly.`,
    inputSchema: CountInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ groupBy, ...filters }) => {
    const output = await countWorkOrdersBy(groupBy, buildFilter(filters));
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

const GetInputSchema = z
  .object({
    workOrderId: z.number().int().positive().describe("The ServiceChannel work order ID"),
  })
  .strict();

server.registerTool(
  "get_work_order",
  {
    title: "Get Work Order",
    description: `Fetch a single ServiceChannel work order by ID. Read-only.

Returns: { id, status: {primary, extended}, trade, tradeId, locationId, priority, priorityId, category, categoryId, description, createdDate, scheduledDate, completedDate, provider: {id, name, contactName, phone, email} | null, invoice: {id, number, status, total, balance, invoiceDate, paidDate} | null }

For the work order's note history, use get_work_order_notes separately — notes aren't included here.`,
    inputSchema: GetInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workOrderId }) => {
    const raw = await apiFetch(`/v3/odata/workorders(${workOrderId})`, {
      $select: WORKORDER_SELECT,
      $expand: WORKORDER_EXPAND,
    });
    const output = toCompactWorkOrder(raw);
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

server.registerTool(
  "get_work_order_notes",
  {
    title: "Get Work Order Notes",
    description: `Fetch the note history for a ServiceChannel work order by ID — e.g. dispatch/reassignment notes, technician check-in/out messages, system events. Read-only.

Returns: { count: number, notes: [{ id, number, text, createdBy, createdDate }] }, oldest first.`,
    inputSchema: GetInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workOrderId }) => {
    const data = await apiFetch(`/v3/odata/workorders(${workOrderId})/notes`, { $select: NOTE_SELECT });
    const notes = (data.value ?? []).map(toCompactNote);
    const output = { count: notes.length, notes };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

server.registerTool(
  "get_work_order_assets",
  {
    title: "Get Work Order Assets",
    description: `Fetch the equipment/asset list tied to a ServiceChannel work order by ID. Read-only.

Returns: { count: number, totalCount: number, truncated: boolean, assets: [{ id, tag, manufacturer, modelNo, serialNo, trade, type, active, locationId }] }

totalCount is the work order's real asset count; truncated is true if there were more assets than the ${ASSET_CAP}-item cap returned. Descriptive fields (tag/manufacturer/modelNo/serialNo/trade/type) are frequently null -- asset records aren't always fully filled out.`,
    inputSchema: GetInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workOrderId }) => {
    const raw = await apiFetch(`/v3/odata/workorders(${workOrderId})`, {
      $select: "Id,AssetCount",
      $expand: `Assets($select=${ASSET_SELECT};$top=${ASSET_CAP})`,
    });
    const assets = (raw.Assets ?? []).map(toCompactAsset);
    const totalCount = raw.AssetCount ?? assets.length;
    const output = { count: assets.length, totalCount, truncated: totalCount > assets.length, assets };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

server.registerTool(
  "get_work_order_activities",
  {
    title: "Get Work Order Activities",
    description: `Fetch the technician check-in/check-out activity history for a ServiceChannel work order by ID. Read-only.

Returns: { count: number, activities: [{ id, timeIn, timeOut, technician, resolutionCode, workType, techsCount }] }, oldest first.`,
    inputSchema: GetInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workOrderId }) => {
    const data = await apiFetch(`/v3/odata/workorders(${workOrderId})/workactivities`, { $select: ACTIVITY_SELECT });
    const activities = (data.value ?? [])
      .map(toCompactActivity)
      .sort((a: { timeIn: string | null }, b: { timeIn: string | null }) =>
        (a.timeIn ?? "").localeCompare(b.timeIn ?? ""),
      );
    const output = { count: activities.length, activities };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

const SearchLocationsInputSchema = z
  .object({
    locationId: z.number().int().positive().optional().describe("Exact ServiceChannel location ID"),
    name: z
      .string()
      .optional()
      .describe("Fuzzy match against location name or street address (case-insensitive substring)"),
    storeId: z.string().optional().describe("Exact store/site code, e.g. 'HQ-NYC'"),
    city: z.string().optional().describe("Exact city name"),
    state: z.string().optional().describe("Exact 2-letter state code"),
    maxResults: z.number().int().min(1).max(50).default(10).describe("Max results to return (server caps at 50)"),
  })
  .strict();

server.registerTool(
  "search_locations",
  {
    title: "Search Locations",
    description: `Look up ServiceChannel locations by ID, name/address (fuzzy), store code, city, or state. Read-only.

Use this to resolve a location name (e.g. "Main Street Store") to the locationId that search_work_orders and get_work_order require. Pass locationId directly to fetch one known location.

Returns: { count: number, locations: [{ id, name, storeId, address, city, state, zip, phone, contact, status }] }`,
    inputSchema: SearchLocationsInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const filter = buildLocationFilter(params);
    const data = await apiFetch("/v3/odata/locations", {
      ...(filter ? { $filter: filter } : {}),
      $select: LOCATION_SELECT,
      $top: String(params.maxResults),
    });
    const locations = (data.value ?? []).map(toCompactLocation);
    const output = { count: locations.length, locations };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

const SearchTradesInputSchema = z
  .object({
    name: z.string().optional().describe("Fuzzy match against trade name (case-insensitive substring), e.g. 'plumb'"),
    maxResults: z.number().int().min(1).max(50).default(25).describe("Max results to return (server caps at 50)"),
  })
  .strict();

server.registerTool(
  "search_trades",
  {
    title: "Search Trades",
    description: `Look up ServiceChannel trade names (e.g. "PLUMBING", "ELECTRICAL"), optionally fuzzy-matched. Read-only.

Use this to discover the exact trade string search_work_orders' \`trade\`/\`category\` filters need — those require an exact match and there's no other way to know valid values in advance. Call with no arguments to list all trades (there are usually only a couple dozen).

Returns: { count: number, trades: [{ id, name }] }`,
    inputSchema: SearchTradesInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const filter = buildTradeFilter(params);
    const data = await apiFetch("/v3/odata/trades", {
      ...(filter ? { $filter: filter } : {}),
      $select: TRADE_SELECT,
      $top: String(params.maxResults),
    });
    const trades = (data.value ?? []).map(toCompactTrade);
    const output = { count: trades.length, trades };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("sc-workorders-mcp running via stdio");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
