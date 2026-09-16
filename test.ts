import assert from "node:assert";
import { apiFetch, buildFilter, buildLocationFilter, toCompactWorkOrder, toCompactLocation } from "./src/sc-client.js";

async function main() {
  const t0 = Date.now();
  const token1 = await apiFetch("/v3/odata/workorders", { $top: "1" });
  const tokenLatency = Date.now() - t0;
  assert.ok(Array.isArray(token1.value), "expected a work order list");
  console.log(`PASS: token + first fetch round-trip (${tokenLatency}ms)`);

  const t1 = Date.now();
  const filter = buildFilter({ maxResults: 5 } as any);
  const searchResult = await apiFetch("/v3/odata/workorders", {
    ...(filter ? { $filter: filter } : {}),
    $expand: "Provider",
    $top: "5",
  });
  const searchLatency = Date.now() - t1;
  const workOrders = (searchResult.value ?? []).map(toCompactWorkOrder);
  assert.ok(workOrders.length <= 5, "search_work_orders should respect maxResults");
  assert.ok(
    workOrders.every((wo: { id: number; status: { primary: string } }) => typeof wo.id === "number" && wo.status.primary),
    "each result needs id + status"
  );
  console.log(`PASS: search_work_orders returned ${workOrders.length} results (${searchLatency}ms)`);

  const testId = process.env.SC_TEST_WORKORDER_ID ? Number(process.env.SC_TEST_WORKORDER_ID) : workOrders[0]?.id;
  assert.ok(testId, "need a work order id to test get_work_order (set SC_TEST_WORKORDER_ID or have search results)");

  const t2 = Date.now();
  const raw = await apiFetch(`/v3/odata/workorders(${testId})`, { $expand: "Provider" });
  const getLatency = Date.now() - t2;
  const wo = toCompactWorkOrder(raw);
  assert.strictEqual(wo.id, testId, "get_work_order should return the requested id");
  assert.ok(
    wo.provider === null || (typeof wo.provider.id === "number" && wo.provider.name),
    "provider should be null or a {id, name, ...} object"
  );
  console.log(`PASS: get_work_order(${testId}) matched, provider=${wo.provider?.name ?? "none"} (${getLatency}ms)`);

  const t4 = Date.now();
  const providerFilter = buildFilter({ providerName: "Fahey" } as any);
  const providerResult = await apiFetch("/v3/odata/workorders", {
    $filter: providerFilter!,
    $expand: "Provider",
    $top: "3",
  });
  const providerLatency = Date.now() - t4;
  const providerMatches = (providerResult.value ?? []).map(toCompactWorkOrder);
  assert.ok(providerMatches.length > 0, "providerName filter should find at least one work order");
  assert.ok(
    providerMatches.every((wo: { provider: { name: string } | null }) =>
      wo.provider?.name.toLowerCase().includes("fahey")
    ),
    "every result should have a provider name containing the filter term (case-insensitive)"
  );
  console.log(`PASS: search_work_orders providerName='Fahey' returned ${providerMatches.length} results (${providerLatency}ms)`);

  const t3 = Date.now();
  const locFilter = buildLocationFilter({ name: "Union" });
  const locResult = await apiFetch("/v3/odata/locations", { $filter: locFilter!, $top: "10" });
  const locLatency = Date.now() - t3;
  const locations = (locResult.value ?? []).map(toCompactLocation);
  assert.ok(locations.length > 0, "search_locations fuzzy name match should find at least one result");
  assert.ok(
    locations.every((loc: { id: number; name: string }) => typeof loc.id === "number" && loc.name),
    "each location needs id + name"
  );
  console.log(`PASS: search_locations name='Union' returned ${locations.length} results (${locLatency}ms)`);

  console.log("\nAll checks passed.");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
