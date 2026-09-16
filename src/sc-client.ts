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
      `Auth failed: token endpoint redirected (status ${res.status}). The OAuth client is likely not registered/active in this environment.`
    );
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
    throw new Error(`Rate limited by ServiceChannel API${retryAfter ? ` — retry after ${retryAfter}s` : ""}.`);
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
  if (f.locationId) clauses.push(`Id eq ${f.locationId}`);
  if (f.name) clauses.push(`(contains(Name,${odataString(f.name)}) or contains(Address2,${odataString(f.name)}))`);
  if (f.storeId) clauses.push(`StoreId eq ${odataString(f.storeId)}`);
  if (f.city) clauses.push(`City eq ${odataString(f.city)}`);
  if (f.state) clauses.push(`State eq ${odataString(f.state)}`);
  return clauses.length ? clauses.join(" and ") : undefined;
}

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

export interface CompactProvider {
  id: number;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
}

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
  };
}

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
