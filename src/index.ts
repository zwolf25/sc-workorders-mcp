#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiFetch, buildFilter, buildLocationFilter, toCompactWorkOrder, toCompactLocation } from "./sc-client.js";

const server = new McpServer({ name: "sc-workorders-mcp", version: "0.1.0" });

const SearchInputSchema = z
  .object({
    status: z
      .string()
      .optional()
      .describe("Work order status, e.g. 'OPEN', 'IN PROGRESS', 'COMPLETED' (case-sensitive, exact match)"),
    trade: z.string().optional().describe("Trade label, e.g. 'ALARMS', 'HVAC'"),
    locationId: z.number().int().positive().optional().describe("ServiceChannel location ID"),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Created on/after this date, YYYY-MM-DD"),
    dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("Created on/before this date, YYYY-MM-DD"),
    providerId: z.number().int().positive().optional().describe("Exact ServiceChannel provider (vendor) ID"),
    providerName: z.string().optional().describe("Fuzzy match against the assigned provider's name"),
    maxResults: z.number().int().min(1).max(50).default(20).describe("Max results to return (server caps at 50)"),
  })
  .strict();

server.registerTool(
  "search_work_orders",
  {
    title: "Search Work Orders",
    description: `Search ServiceChannel work orders by status, trade, location, provider, and/or date range. Read-only.

Returns: { count: number, workOrders: [{ id, status: {primary, extended}, trade, locationId, priority, description, createdDate, scheduledDate, completedDate, provider: {id, name, contactName, phone, email} | null }] }`,
    inputSchema: SearchInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async (params) => {
    const filter = buildFilter(params);
    const data = await apiFetch("/v3/odata/workorders", {
      ...(filter ? { $filter: filter } : {}),
      $expand: "Provider",
      $top: String(params.maxResults),
    });
    const workOrders = (data.value ?? []).map(toCompactWorkOrder);
    const output = { count: workOrders.length, workOrders };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  }
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

Returns: { id, status: {primary, extended}, trade, locationId, priority, description, createdDate, scheduledDate, completedDate, provider: {id, name, contactName, phone, email} | null }`,
    inputSchema: GetInputSchema.shape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  async ({ workOrderId }) => {
    const raw = await apiFetch(`/v3/odata/workorders(${workOrderId})`, { $expand: "Provider" });
    const output = toCompactWorkOrder(raw);
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  }
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
      $top: String(params.maxResults),
    });
    const locations = (data.value ?? []).map(toCompactLocation);
    const output = { count: locations.length, locations };
    return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output };
  }
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
