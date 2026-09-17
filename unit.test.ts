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

const { buildFilter, buildLocationFilter, buildOrderBy, toCompactWorkOrder, toCompactLocation, toCompactNote } =
  await import("./src/sc-client.js");

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
});
assert.strictEqual(compact.id, 1);
assert.deepStrictEqual(compact.provider, { id: 7, name: "Acme", contactName: "Jane", phone: "555", email: "a@b.com" });

const compactNoProvider = toCompactWorkOrder({ Id: 2, Status: {}, LocationId: 1, CreatedDate: "2026-01-01" });
assert.strictEqual(compactNoProvider.provider, null, "a missing Provider maps to null, not undefined or a throw");
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

console.log("\nAll unit checks passed.");
