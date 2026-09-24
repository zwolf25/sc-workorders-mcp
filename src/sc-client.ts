const REQUIRED_ENV = ["SC_CLIENT_ID", "SC_CLIENT_SECRET", "SC_USERNAME", "SC_PASSWORD"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`ERROR: ${key} environment variable is required`);
    process.exit(1);
  }
}

const CLIENT_ID = process.env.SC_CLIENT_ID!;
const CLIENT_SECRET = process.env.SC_CLIENT_SECRET!;
const USERNAME = process.env.SC_USERNAME!;
const PASSWORD = process.env.SC_PASSWORD!;
const TOKEN_URL = process.env.SC_TOKEN_URL ?? "https://sb2login.servicechannel.com/oauth/token";
const API_BASE_URL = process.env.SC_API_BASE_URL ?? "https://sb2api.servicechannel.com";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;
let apiCalls = 0;
export const apiCallCount = () => apiCalls;

async function fetchToken(): Promise<string> {
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");
  const body = new URLSearchParams({ grant_type: "password", username: USERNAME, password: PASSWORD });

  // redirect: "manual" so a 302 (unregistered/inactive OAuth client) surfaces
  // as a status code instead of silently following to the HTML login page.
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    redirect: "manual",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `Auth failed: token endpoint redirected (status ${res.status}). SC_CLIENT_ID or SC_CLIENT_SECRET was rejected — check both, and that the OAuth client was created in this environment itself (not synced from another one).`,
    );
  }
  if (res.status === 400) {
    // Live-verified: a wrong username/password returns 400 "invalid credentials" (a wrong client ID or secret is the 302 above).
    throw new Error("Auth failed: SC_USERNAME or SC_PASSWORD was rejected (token endpoint returned 400).");
  }
  if (!res.ok) {
    throw new Error(`Auth failed: token endpoint returned ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 30) * 1000 };
  return tokenCache.token;
}

async function getToken(): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  return fetchToken();
}

export async function apiFetch(path: string, params: Record<string, string> = {}, retrying = false): Promise<any> {
  const token = await getToken();
  apiCalls++;
  const url = new URL(`${API_BASE_URL}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });

  if (res.status === 401 && !retrying) {
    tokenCache = null;
    return apiFetch(path, params, true);
  }
  if (res.status === 401) {
    throw new Error("Auth failed: got 401 again even after refreshing the token.");
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After");
    throw new Error(
      `Rate limited by ServiceChannel API${retryAfter ? ` — retry after ${/^\d+$/.test(retryAfter) ? `${retryAfter}s` : retryAfter}` : ""}.`,
    );
  }
  if (res.status === 404) {
    throw new Error("Work order not found.");
  }
  if (!res.ok) {
    throw new Error(`ServiceChannel API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export interface SearchFilters {
  status?: string;
  trade?: string;
  locationId?: number;
  dateFrom?: string;
  dateTo?: string;
  providerId?: number;
  providerName?: string;
  category?: string;
  scheduledDateFrom?: string;
  scheduledDateTo?: string;
  completedDateFrom?: string;
  completedDateTo?: string;
}

function odataString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

// Only these whitelisted fields ever reach the $filter clause — the LLM
// never supplies a raw OData string.
export function buildFilter(f: SearchFilters): string | undefined {
  const clauses: string[] = [];
  if (f.status) clauses.push(`Status/Primary eq ${odataString(f.status)}`);
  if (f.trade) clauses.push(`Trade eq ${odataString(f.trade)}`);
  if (f.locationId) clauses.push(`LocationId eq ${f.locationId}`);
  if (f.dateFrom) clauses.push(`CreatedDate ge ${f.dateFrom}T00:00:00Z`);
  if (f.dateTo) clauses.push(`CreatedDate le ${f.dateTo}T23:59:59Z`);
  if (f.providerId) clauses.push(`Provider/Id eq ${f.providerId}`);
  if (f.providerName) clauses.push(`contains(Provider/Name,${odataString(f.providerName)})`);
  if (f.category) clauses.push(`Category eq ${odataString(f.category)}`);
  if (f.scheduledDateFrom) clauses.push(`ScheduledDate ge ${f.scheduledDateFrom}T00:00:00Z`);
  if (f.scheduledDateTo) clauses.push(`ScheduledDate le ${f.scheduledDateTo}T23:59:59Z`);
  if (f.completedDateFrom) clauses.push(`CompletedDate ge ${f.completedDateFrom}T00:00:00Z`);
  if (f.completedDateTo) clauses.push(`CompletedDate le ${f.completedDateTo}T23:59:59Z`);
  return clauses.length ? clauses.join(" and ") : undefined;
}

// Whitelisted sortable fields only — the LLM picks from an enum in the tool
// schema, never supplies a raw OData property name.
const SORTABLE_FIELDS: Record<string, string> = {
  createdDate: "CreatedDate",
  scheduledDate: "ScheduledDate",
  completedDate: "CompletedDate",
};

export function buildOrderBy(sortBy?: string, sortOrder: "asc" | "desc" = "desc"): string | undefined {
  if (!sortBy) return undefined;
  const field = SORTABLE_FIELDS[sortBy];
  return field ? `${field} ${sortOrder}` : undefined;
}

export interface LocationFilters {
  locationId?: number;
  name?: string;
  storeId?: string;
  city?: string;
  state?: string;
}

// Same whitelist approach as buildFilter: only these fields reach $filter.
// contains() on Name/Address2 is case-insensitive on this API (verified live),
// so a plain substring gives reasonable fuzzy matching without a client-side lib.
export function buildLocationFilter(f: LocationFilters): string | undefined {
  const clauses: string[] = [];
  // `Id eq {id}` here is a workaround, not an incidental filter: /locations({id})
  // (the parens single-item syntax) is broken server-side (see ARCHITECTURE.md's
  // quirks). Any future entity with the same parens-500 bug (invoices is one,
  // per BACKLOG.md) should reach for this same `{Field} eq {id}` pattern.
  if (f.locationId) clauses.push(`Id eq ${f.locationId}`);
  if (f.name) clauses.push(`(contains(Name,${odataString(f.name)}) or contains(Address2,${odataString(f.name)}))`);
  if (f.storeId) clauses.push(`StoreId eq ${odataString(f.storeId)}`);
  if (f.city) clauses.push(`City eq ${odataString(f.city)}`);
  if (f.state) clauses.push(`State eq ${odataString(f.state)}`);
  return clauses.length ? clauses.join(" and ") : undefined;
}

// Kept next to toCompactLocation on purpose: if a field is added to one,
// it belongs in the other too, or it'll silently come back undefined.
export const LOCATION_SELECT = "Id,Name,StoreId,Address1,Address2,City,State,Zip,Phone,Contact,Status";

export interface CompactLocation {
  [key: string]: unknown;
  id: number;
  name: string;
  storeId: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string | null;
  contact: string | null;
  status: string;
}

export function toCompactLocation(raw: any): CompactLocation {
  const address = [raw.Address1, raw.Address2].filter(Boolean).join(", ");
  return {
    id: raw.Id,
    name: raw.Name ?? "",
    storeId: raw.StoreId ?? "",
    address,
    city: raw.City ?? "",
    state: raw.State ?? "",
    zip: raw.Zip ?? "",
    phone: raw.Phone ?? null,
    contact: raw.Contact ?? null,
    status: raw.Status ?? "",
  };
}

export interface TradeFilters {
  name?: string;
}

// Same whitelist approach as buildFilter/buildLocationFilter. contains() on
// Name is case-insensitive here too (confirmed live: 'maint' matched
// "GENERAL MAINTENANCE"), matching the pattern already established for
// locations and provider names.
export function buildTradeFilter(f: TradeFilters): string | undefined {
  return f.name ? `contains(Name,${odataString(f.name)})` : undefined;
}

// Kept next to toCompactTrade on purpose: if a field is added to one, it
// belongs in the other too.
export const TRADE_SELECT = "Id,Name";

export interface CompactTrade {
  id: number;
  name: string;
}

export function toCompactTrade(raw: any): CompactTrade {
  return {
    id: raw.Id,
    name: raw.Name ?? "",
  };
}

export interface CompactProvider {
  id: number;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
}

export interface CompactInvoice {
  id: number;
  number: string;
  status: string;
  total: number;
  balance: number | null;
  invoiceDate: string;
  paidDate: string | null;
}

// Kept next to toCompactWorkOrder on purpose: if a field is added to one,
// it belongs in the other too, or it'll silently come back undefined.
// Provider/Invoice must be in both this list and $expand for the nested
// objects to come back at all (both are navigation properties, not plain
// fields). WORKORDER_EXPAND uses nested $expand($select=...) to trim each
// one down to only the fields the two Compact* mappers actually read --
// confirmed live to compose cleanly with a bare $select on the outer entity.
export const WORKORDER_SELECT =
  "Id,Status,Trade,TradeId,LocationId,Priority,PriorityId,Category,CategoryId,Description,CreatedDate,ScheduledDate,CompletedDate,Provider,Invoice";
export const WORKORDER_EXPAND =
  "Provider($select=Id,Name,MainContact,Phone,Email),Invoice($select=Id,Number,Status,InvoiceTotal,InvoiceBalance,InvoiceDate,PaidDate)";

export interface CompactWorkOrder {
  [key: string]: unknown;
  id: number;
  status: { primary: string; extended: string };
  trade: string;
  tradeId: number | null;
  locationId: number;
  priority: string;
  priorityId: number | null;
  category: string;
  categoryId: number | null;
  description: string;
  createdDate: string;
  scheduledDate: string | null;
  completedDate: string | null;
  provider: CompactProvider | null;
  invoice: CompactInvoice | null;
}

export function toCompactWorkOrder(raw: any): CompactWorkOrder {
  return {
    id: raw.Id,
    status: { primary: raw.Status?.Primary ?? "", extended: raw.Status?.Extended ?? "" },
    trade: raw.Trade ?? "",
    tradeId: raw.TradeId ?? null,
    locationId: raw.LocationId,
    priority: raw.Priority ?? "",
    priorityId: raw.PriorityId ?? null,
    category: raw.Category ?? "",
    categoryId: raw.CategoryId ?? null,
    description: raw.Description ?? "",
    createdDate: raw.CreatedDate,
    scheduledDate: raw.ScheduledDate ?? null,
    completedDate: raw.CompletedDate ?? null,
    provider: raw.Provider
      ? {
          id: raw.Provider.Id,
          name: raw.Provider.Name ?? "",
          contactName: raw.Provider.MainContact ?? null,
          phone: raw.Provider.Phone ?? null,
          email: raw.Provider.Email ?? null,
        }
      : null,
    invoice: raw.Invoice
      ? {
          id: raw.Invoice.Id,
          number: raw.Invoice.Number ?? "",
          status: raw.Invoice.Status ?? "",
          total: raw.Invoice.InvoiceTotal ?? 0,
          balance: raw.Invoice.InvoiceBalance ?? null,
          invoiceDate: raw.Invoice.InvoiceDate,
          paidDate: raw.Invoice.PaidDate ?? null,
        }
      : null,
  };
}

// Kept next to toCompactNote on purpose: if a field is added to one,
// it belongs in the other too, or it'll silently come back undefined.
export const NOTE_SELECT = "Id,Number,NoteData,CreatedBy,DateCreated";

export interface CompactNote {
  id: number;
  number: number;
  text: string;
  createdBy: string;
  createdDate: string;
}

export function toCompactNote(raw: any): CompactNote {
  return {
    id: raw.Id,
    number: raw.Number,
    text: raw.NoteData ?? "",
    createdBy: raw.CreatedBy ?? "",
    createdDate: raw.DateCreated,
  };
}

// Kept next to toCompactAsset on purpose: if a field is added to one, it
// belongs in the other too. Nested $select works inside $expand=Assets(...)
// the same way it does for Provider/Invoice (confirmed live).
export const ASSET_SELECT = "Id,Tag,Manufacturer,ModelNo,SerialNo,Trade,Type,Active,LocationId";

// $expand=Assets($top=N) genuinely caps the returned array server-side on the
// single-item /workorders({id}) endpoint (confirmed live: $top=10 returned
// exactly 10 of a real AssetCount of 60) -- unlike the list endpoint, which
// silently caps nested Assets at 50 regardless of what $top is requested
// inside $expand. Since get_work_order_assets uses the single-item endpoint,
// this cap is a real, working safeguard, not a cosmetic one.
export const ASSET_CAP = 50;

export interface CompactAsset {
  id: number;
  tag: string | null;
  manufacturer: string | null;
  modelNo: string | null;
  serialNo: string | null;
  trade: string | null;
  type: string | null;
  active: boolean;
  locationId: number | null;
}

// Sandbox asset data is sparse -- every asset seen live so far has null
// descriptive fields (Tag/Manufacturer/ModelNo/SerialNo/Trade/Type) except
// Id/Active/LocationId, so null-safety here is load-bearing, not decorative.
export function toCompactAsset(raw: any): CompactAsset {
  return {
    id: raw.Id,
    tag: raw.Tag ?? null,
    manufacturer: raw.Manufacturer ?? null,
    modelNo: raw.ModelNo ?? null,
    serialNo: raw.SerialNo ?? null,
    trade: raw.Trade ?? null,
    type: raw.Type ?? null,
    active: raw.Active ?? false,
    locationId: raw.LocationId ?? null,
  };
}

// Kept next to toCompactActivity on purpose: if a field is added to one, it
// belongs in the other too. $select works on this sub-resource including
// pulling the nested User object, same as notes' $select (confirmed live).
export const ACTIVITY_SELECT = "Id,TimeIn,TimeOut,User,ResolutionCode,WorkType,TechsCount";

export interface CompactActivity {
  id: number;
  timeIn: string | null;
  timeOut: string | null;
  technician: string | null;
  resolutionCode: string | null;
  workType: string | null;
  techsCount: number | null;
}

export function toCompactActivity(raw: any): CompactActivity {
  return {
    id: raw.Id,
    timeIn: raw.TimeIn ?? null,
    timeOut: raw.TimeOut ?? null,
    technician: raw.User?.FullName ?? null,
    resolutionCode: raw.ResolutionCode ?? null,
    workType: raw.WorkType ?? null,
    techsCount: raw.TechsCount ?? null,
  };
}

// $apply=groupby is unsupported by this API (HTTP 400), so per-group counts are one $count request per value.
// The API also throttles per application (says 40/min, but ~20 succeeded from a fresh window in practice), so this
// runs sequentially under a small request budget and returns partial counts instead of throwing if it is throttled.
const GROUP_FIELDS = { status: "Status/Primary", trade: "Trade", category: "Category" } as const;
export type GroupBy = keyof typeof GROUP_FIELDS;
export const GROUP_BY = Object.keys(GROUP_FIELDS) as [GroupBy, ...GroupBy[]];
const GROUP_REQUEST_BUDGET = 15;

const joinAnd = (...clauses: (string | undefined)[]) => clauses.filter(Boolean).join(" and ") || undefined;

export type GroupCounts = {
  totalCount: number;
  groups: { value: string; count: number }[];
  other: number; // matches not covered by `groups` (null values, or values cut off by the request budget)
  truncated: boolean;
};

export async function countWorkOrdersBy(groupBy: GroupBy, baseFilter: string | undefined): Promise<GroupCounts> {
  const path = GROUP_FIELDS[groupBy];
  let calls = 0;
  const countWhere = async (filter: string | undefined): Promise<number> => {
    calls++;
    const data = await apiFetch("/v3/odata/workorders", {
      ...(filter ? { $filter: filter } : {}),
      $top: "0",
      $count: "true",
    });
    return data["@odata.count"] ?? 0;
  };
  const totalCount = await countWhere(baseFilter);
  const groups: GroupCounts["groups"] = [];
  const countValue = async (v: string) =>
    groups.push({ value: v, count: await countWhere(joinAnd(baseFilter, `${path} eq ${odataString(v)}`)) });
  let truncated = false;

  try {
    if (groupBy === "trade") {
      // Trades have a real directory endpoint; status/category don't, so those are discovered below.
      calls++;
      const trades = await apiFetch("/v3/odata/trades", { $select: TRADE_SELECT, $top: "50" });
      for (const t of trades.value ?? []) {
        if (calls >= GROUP_REQUEST_BUDGET) {
          truncated = true;
          break;
        }
        await countValue(t.Name);
      }
    } else {
      // Peel: fetch one row not matching any value seen so far, count its value, repeat until none remain.
      // `Status` is a nested object, hence the row.Status.Primary read; discovery beats a hardcoded list because
      // Status/Primary isn't a closed enum.
      const seen: string[] = [];
      while (calls + 2 <= GROUP_REQUEST_BUDGET) {
        calls++;
        const filter = joinAnd(baseFilter, ...seen.map((v) => `${path} ne ${odataString(v)}`));
        const data = await apiFetch("/v3/odata/workorders", {
          ...(filter ? { $filter: filter } : {}),
          $select: groupBy === "status" ? "Status" : "Category",
          $top: "1",
        });
        const row = data.value?.[0];
        const value = groupBy === "status" ? row?.Status?.Primary : row?.Category;
        if (value == null) break; // no rows left, or a null value that can't be excluded by `ne`
        seen.push(value);
        await countValue(value);
        truncated = calls + 2 > GROUP_REQUEST_BUDGET;
      }
    }
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("Rate limited")) throw e;
    truncated = true; // keep the counts gathered so far
  }

  groups.sort((a, b) => b.count - a.count);
  const other = totalCount - groups.reduce((sum, g) => sum + g.count, 0);
  return { totalCount, groups, other, truncated: truncated && other > 0 };
}

// get_work_order_context: work order + invoice + provider + assets in ONE
// single-item request (WORKORDER_EXPAND and Assets compose in $expand), plus
// notes via their sub-resource (the only working path). 2 requests, not 3.
// Notes run second, so a throttle there returns the rest with notes: null.
export function toWorkOrderContext(raw: any, notes: any[] | null) {
  const assets = (raw.Assets ?? []).map(toCompactAsset);
  const totalCount = raw.AssetCount ?? assets.length;
  const compactNotes = notes?.map(toCompactNote);
  return {
    ...toCompactWorkOrder(raw),
    assets: { count: assets.length, totalCount, truncated: totalCount > assets.length, items: assets },
    notes: compactNotes ? { count: compactNotes.length, items: compactNotes } : null,
    notesTruncated: notes === null,
  };
}

export async function getWorkOrderContext(workOrderId: number) {
  const raw = await apiFetch(`/v3/odata/workorders(${workOrderId})`, {
    $select: `${WORKORDER_SELECT},AssetCount`,
    $expand: `${WORKORDER_EXPAND},Assets($select=${ASSET_SELECT};$top=${ASSET_CAP})`,
  });
  let notes: any[] | null = null;
  try {
    notes = (await apiFetch(`/v3/odata/workorders(${workOrderId})/notes`, { $select: NOTE_SELECT })).value ?? [];
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith("Rate limited")) throw e;
  }
  return toWorkOrderContext(raw, notes);
}
