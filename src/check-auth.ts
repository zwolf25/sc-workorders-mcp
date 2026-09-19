import { apiFetch } from "./sc-client.js";

// Confirms the SC_* credentials work end to end (token fetch + one API call) without starting the MCP server.
try {
  await apiFetch("/v3/odata/trades", { $select: "Id", $top: "1" });
  const host = new URL(process.env.SC_API_BASE_URL ?? "https://sb2api.servicechannel.com").host;
  console.log(`OK: authenticated as ${process.env.SC_USERNAME} against ${host}`);
} catch (error) {
  console.error("FAIL:", error instanceof Error ? error.message : error);
  process.exit(1);
}
