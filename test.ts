import assert from "node:assert";
import {
  apiFetch,
  buildFilter,
  buildLocationFilter,
  buildOrderBy,
  toCompactWorkOrder,
  toCompactLocation,
  toCompactNote,
  WORKORDER_SELECT,
  LOCATION_SELECT,
  NOTE_SELECT,
} from "./src/sc-client.js";

// Fixture convention: most values below (work order/provider/location names,
// the notes work order ID) are hardcoded real records in the SB2 sandbox, not
// read from env. That's deliberate, not an oversight — this script is a live
// integration test with no mocking, and these are stable enough sandbox
// fixtures that env-var plumbing for each one would be pure ceremony. The one
// exception, SC_TEST_WORKORDER_ID, exists because get_work_order's fixture
// only needs *some* real ID, not a specific one with specific data (unlike
// the notes/category/provider checks, which depend on specific field values
// only certain records have).

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
    $select: WORKORDER_SELECT,
    $expand: "Provider",
    $top: "5",
  });
  const searchLatency = Date.now() - t1;
  const workOrders = (searchResult.value ?? []).map(toCompactWorkOrder);
  assert.ok(workOrders.length <= 5, "search_work_orders should respect maxResults");
  assert.ok(
    workOrders.every(
      (wo: { id: number; status: { primary: string } }) => typeof wo.id === "number" && wo.status.primary,
    ),
    "each result needs id + status",
  );
  console.log(`PASS: search_work_orders returned ${workOrders.length} results (${searchLatency}ms)`);

  const testId = process.env.SC_TEST_WORKORDER_ID ? Number(process.env.SC_TEST_WORKORDER_ID) : workOrders[0]?.id;
  assert.ok(testId, "need a work order id to test get_work_order (set SC_TEST_WORKORDER_ID or have search results)");

  const t2 = Date.now();
  const raw = await apiFetch(`/v3/odata/workorders(${testId})`, { $select: WORKORDER_SELECT, $expand: "Provider" });
  const getLatency = Date.now() - t2;
  const wo = toCompactWorkOrder(raw);
  assert.strictEqual(wo.id, testId, "get_work_order should return the requested id");
  assert.ok(
    wo.provider === null || (typeof wo.provider.id === "number" && wo.provider.name),
    "provider should be null or a {id, name, ...} object",
  );
  console.log(`PASS: get_work_order(${testId}) matched, provider=${wo.provider?.name ?? "none"} (${getLatency}ms)`);

  const t4 = Date.now();
  const providerFilter = buildFilter({ providerName: "Fahey" } as any);
  const providerResult = await apiFetch("/v3/odata/workorders", {
    $filter: providerFilter!,
    $select: WORKORDER_SELECT,
    $expand: "Provider",
    $top: "3",
  });
  const providerLatency = Date.now() - t4;
  const providerMatches = (providerResult.value ?? []).map(toCompactWorkOrder);
  assert.ok(providerMatches.length > 0, "providerName filter should find at least one work order");
  assert.ok(
    providerMatches.every((wo: { provider: { name: string } | null }) =>
      wo.provider?.name.toLowerCase().includes("fahey"),
    ),
    "every result should have a provider name containing the filter term (case-insensitive)",
  );
  console.log(
    `PASS: search_work_orders providerName='Fahey' returned ${providerMatches.length} results (${providerLatency}ms)`,
  );

  const t3 = Date.now();
  const locFilter = buildLocationFilter({ name: "Union" });
  const locResult = await apiFetch("/v3/odata/locations", {
    $filter: locFilter!,
    $select: LOCATION_SELECT,
    $top: "10",
  });
  const locLatency = Date.now() - t3;
  const locations = (locResult.value ?? []).map(toCompactLocation);
  assert.ok(locations.length > 0, "search_locations fuzzy name match should find at least one result");
  assert.ok(
    locations.every((loc: { id: number; name: string }) => typeof loc.id === "number" && loc.name),
    "each location needs id + name",
  );
  console.log(`PASS: search_locations name='Union' returned ${locations.length} results (${locLatency}ms)`);

  const t5 = Date.now();
  const categoryFilter = buildFilter({ category: "REPAIR", completedDateFrom: "2020-01-01" } as any);
  const categoryResult = await apiFetch("/v3/odata/workorders", {
    $filter: categoryFilter!,
    $select: WORKORDER_SELECT,
    $expand: "Provider",
    $top: "5",
  });
  const categoryLatency = Date.now() - t5;
  const categoryMatches = (categoryResult.value ?? []).map(toCompactWorkOrder);
  assert.ok(categoryMatches.length > 0, "category+completedDateFrom filter should find at least one work order");
  assert.ok(
    categoryMatches.every(
      (wo: { category: string; completedDate: string | null }) => wo.category === "REPAIR" && wo.completedDate,
    ),
    "every result should be REPAIR category with a non-null completedDate",
  );
  console.log(
    `PASS: search_work_orders category+completedDateFrom returned ${categoryMatches.length} results (${categoryLatency}ms)`,
  );

  const t6 = Date.now();
  const orderBy = buildOrderBy("createdDate", "desc");
  const sortResult = await apiFetch("/v3/odata/workorders", {
    $orderby: orderBy!,
    $select: WORKORDER_SELECT,
    $expand: "Provider",
    $top: "10",
  });
  const sortLatency = Date.now() - t6;
  const sorted = (sortResult.value ?? []).map(toCompactWorkOrder);
  const isNonIncreasing = sorted.every(
    (wo: { createdDate: string }, i: number) => i === 0 || wo.createdDate <= sorted[i - 1].createdDate,
  );
  assert.ok(isNonIncreasing, "sortBy=createdDate desc should return non-increasing createdDate values");
  console.log(
    `PASS: search_work_orders sortBy=createdDate desc returned ${sorted.length} results in order (${sortLatency}ms)`,
  );

  const t7 = Date.now();
  const [page1, page2] = await Promise.all([
    apiFetch("/v3/odata/workorders", { $top: "5", $skip: "0", $count: "true", $select: WORKORDER_SELECT }),
    apiFetch("/v3/odata/workorders", { $top: "5", $skip: "5", $count: "true", $select: WORKORDER_SELECT }),
  ]);
  const pageLatency = Date.now() - t7;
  const page1Ids = new Set((page1.value ?? []).map((wo: any) => wo.Id));
  const page2Ids = (page2.value ?? []).map((wo: any) => wo.Id);
  assert.ok(
    page2Ids.every((id: number) => !page1Ids.has(id)),
    "offset=5 page should not overlap offset=0 page",
  );
  const totalCount = page1["@odata.count"];
  assert.ok(typeof totalCount === "number" && totalCount > 10, "@odata.count should report the full match count");
  console.log(`PASS: pagination offset=0/5 non-overlapping, totalCount=${totalCount} (${pageLatency}ms)`);

  const t8 = Date.now();
  const notesData = await apiFetch(`/v3/odata/workorders(355703118)/notes`, { $select: NOTE_SELECT });
  const notesLatency = Date.now() - t8;
  const notes = (notesData.value ?? []).map(toCompactNote);
  assert.ok(notes.length > 1, "known multi-note work order should return more than one note");
  assert.ok(
    notes.every((n: { text: string; createdBy: string }) => n.text && n.createdBy),
    "every note should have non-empty text and createdBy",
  );
  console.log(`PASS: get_work_order_notes(355703118) returned ${notes.length} notes (${notesLatency}ms)`);

  console.log("\nAll checks passed.");
}

main().catch((error) => {
  console.error("FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
});
