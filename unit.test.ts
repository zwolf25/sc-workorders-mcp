import assert from "node:assert";

// sc-client.ts fails fast on missing SC_* env vars at import time (by design,
// for the real server) -- these placeholders unblock importing its pure
// functions here without needing real credentials. Dynamic import (not a
// static one) so this runs *after* the placeholders are set; ES module
// static imports are hoisted and would run before any code in this file.
process.env.SC_CLIENT_ID ??= "unit-test-placeholder";
process.env.SC_CLIENT_SECRET ??= "unit-test-placeholder";
process.env.SC_USERNAME ??= "unit-test-placeholder";
process.env.SC_PASSWORD ??= "unit-test-placeholder";

const {
  buildFilter,
  buildLocationFilter,
  buildOrderBy,
  buildTradeFilter,
  toCompactWorkOrder,
  toCompactLocation,
  toCompactNote,
  toCompactTrade,
  toCompactAsset,
  toCompactActivity,
  toWorkOrderContext,
} = await import("./src/sc-client.js");
const { toolMetric } = await import("./src/metrics.js");

// buildFilter
assert.strictEqual(buildFilter({}), undefined, "no fields -> no filter");
assert.strictEqual(buildFilter({ status: "OPEN" }), "Status/Primary eq 'OPEN'");
assert.strictEqual(
  buildFilter({ status: "OPEN", locationId: 123 }),
  "Status/Primary eq 'OPEN' and LocationId eq 123",
  "multiple fields join with 'and', in field-declaration order",
);
assert.strictEqual(
  buildFilter({ providerName: "O'Brien" }),
  "contains(Provider/Name,'O''Brien')",
  "a literal single quote in a value gets OData-escaped by doubling",
);
console.log("PASS: buildFilter");

// buildLocationFilter
assert.strictEqual(buildLocationFilter({}), undefined);
assert.strictEqual(buildLocationFilter({ locationId: 5 }), "Id eq 5");
assert.strictEqual(buildLocationFilter({ name: "Union" }), "(contains(Name,'Union') or contains(Address2,'Union'))");
console.log("PASS: buildLocationFilter");

// buildOrderBy
assert.strictEqual(buildOrderBy(undefined), undefined, "no sortBy -> no orderby");
assert.strictEqual(buildOrderBy("createdDate"), "CreatedDate desc", "defaults to desc");
assert.strictEqual(buildOrderBy("createdDate", "asc"), "CreatedDate asc");
assert.strictEqual(
  buildOrderBy("notARealField" as any),
  undefined,
  "a field outside the whitelist is silently rejected, never passed through raw",
);
console.log("PASS: buildOrderBy");

// toCompactWorkOrder
const compact = toCompactWorkOrder({
  Id: 1,
  Status: { Primary: "OPEN", Extended: "" },
  Trade: "HVAC",
  TradeId: 5,
  LocationId: 99,
  Priority: "High",
  PriorityId: 2,
  Category: "REPAIR",
  CategoryId: 3,
  Description: "desc",
  CreatedDate: "2026-01-01",
  ScheduledDate: null,
  CompletedDate: null,
  Provider: { Id: 7, Name: "Acme", MainContact: "Jane", Phone: "555", Email: "a@b.com" },
  Invoice: {
    Id: 8,
    Number: "INV-1",
    Status: "OPEN",
    InvoiceTotal: 100.5,
    InvoiceBalance: 50,
    InvoiceDate: "2026-01-02",
    PaidDate: null,
  },
});
assert.strictEqual(compact.id, 1);
assert.deepStrictEqual(compact.provider, { id: 7, name: "Acme", contactName: "Jane", phone: "555", email: "a@b.com" });
assert.deepStrictEqual(compact.invoice, {
  id: 8,
  number: "INV-1",
  status: "OPEN",
  total: 100.5,
  balance: 50,
  invoiceDate: "2026-01-02",
  paidDate: null,
});

const compactNoProvider = toCompactWorkOrder({ Id: 2, Status: {}, LocationId: 1, CreatedDate: "2026-01-01" });
assert.strictEqual(compactNoProvider.provider, null, "a missing Provider maps to null, not undefined or a throw");
assert.strictEqual(compactNoProvider.invoice, null, "a missing Invoice maps to null, not undefined or a throw");
assert.strictEqual(compactNoProvider.trade, "", "missing string fields default to empty string, not undefined");
console.log("PASS: toCompactWorkOrder");

// toCompactLocation
const loc = toCompactLocation({ Id: 1, Address1: "123", Address2: "Suite 4" });
assert.strictEqual(loc.address, "123, Suite 4", "address joins Address1+Address2");
const locNoAddress2 = toCompactLocation({ Id: 2, Address1: "456" });
assert.strictEqual(locNoAddress2.address, "456", "a missing Address2 doesn't leave a trailing separator");
console.log("PASS: toCompactLocation");

// toCompactNote
const note = toCompactNote({ Id: 1, Number: 1, NoteData: "hello", CreatedBy: "Bob", DateCreated: "2026-01-01" });
assert.strictEqual(note.text, "hello");
console.log("PASS: toCompactNote");

// buildTradeFilter
assert.strictEqual(buildTradeFilter({}), undefined, "no name -> no filter");
assert.strictEqual(buildTradeFilter({ name: "plumb" }), "contains(Name,'plumb')");
console.log("PASS: buildTradeFilter");

// toCompactTrade
const trade = toCompactTrade({ Id: 1, Name: "PLUMBING", SubscriberId: 123 });
assert.deepStrictEqual(trade, { id: 1, name: "PLUMBING" }, "SubscriberId is dropped, not just Id/Name kept");
console.log("PASS: toCompactTrade");

// toCompactAsset
const asset = toCompactAsset({ Id: 1, Tag: "A-1", Manufacturer: "Acme", Active: true, LocationId: 9 });
assert.deepStrictEqual(asset, {
  id: 1,
  tag: "A-1",
  manufacturer: "Acme",
  modelNo: null,
  serialNo: null,
  trade: null,
  type: null,
  active: true,
  locationId: 9,
});
const assetSparse = toCompactAsset({ Id: 2 });
assert.strictEqual(assetSparse.tag, null, "missing descriptive fields default to null, not undefined");
assert.strictEqual(assetSparse.active, false, "missing Active defaults to false");
console.log("PASS: toCompactAsset");

// toCompactActivity
const activity = toCompactActivity({
  Id: 1,
  TimeIn: "2026-01-01T09:00:00Z",
  TimeOut: "2026-01-01T10:00:00Z",
  User: { FullName: "Jane Doe" },
  ResolutionCode: "COMPLETE",
  WorkType: "Repair",
  TechsCount: 1,
});
assert.strictEqual(activity.technician, "Jane Doe", "technician is read from the nested User.FullName");
const activityNoUser = toCompactActivity({ Id: 2 });
assert.strictEqual(activityNoUser.technician, null, "a missing User maps technician to null, not a throw");
console.log("PASS: toCompactActivity");

// toWorkOrderContext
const ctx = toWorkOrderContext({ Id: 1, AssetCount: 60, Assets: [{ Id: 9 }] }, [{ Id: 5, NoteData: "hi" }]);
assert.deepStrictEqual([ctx.id, ctx.assets.count, ctx.assets.truncated], [1, 1, true], "assets carry the real total");
assert.strictEqual(ctx.notes?.count, 1, "notes are mapped");
assert.strictEqual(ctx.notesTruncated, false);
const ctxThrottled = toWorkOrderContext({ Id: 1 }, null);
assert.deepStrictEqual([ctxThrottled.notes, ctxThrottled.notesTruncated], [null, true], "null notes flag a throttle");
console.log("PASS: toWorkOrderContext");

// toolMetric
const metric = toolMetric("t", 12, 3, { content: [{ type: "text", text: "a".repeat(401) }] }, false);
assert.strictEqual(metric.bytes, 401, "bytes counts the result text");
assert.strictEqual(metric.estTokens, 101, "estTokens rounds bytes/4 up");
assert.deepStrictEqual([metric.ms, metric.apiCalls, metric.error], [12, 3, false]);
assert.strictEqual(toolMetric("t", 1, 0, undefined, true).bytes, 0, "a failed call (no result) records 0 bytes");
console.log("PASS: toolMetric");

console.log("\nAll unit checks passed.");
