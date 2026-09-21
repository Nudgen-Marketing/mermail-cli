import { operations } from "../src/operations.js";

const baseUrl = (process.env.MERMAIL_BASE_URL ?? "https://console.mermail.app").replace(/\/+$/, "");
const cardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
if (!cardResponse.ok) throw new Error(`Server card returned HTTP ${cardResponse.status}`);
const card = await cardResponse.json() as any;
const advertised = card.capabilities?.tools?.list;
if (!Array.isArray(advertised)) throw new Error("Remote MCP server card has no tool list");
const remote = advertised.filter((name: unknown): name is string => typeof name === "string");
const local = operations.map((operation) => operation.tool).sort();
const remoteNames = new Set(remote);
const missing = local.filter((name) => !remoteNames.has(name));
if (missing.length) throw new Error(`Remote MCP catalog is missing required tools: ${missing.join(", ")}`);
const allowedRemoteOnly = new Set(["prepare_destructive_action", "set_default_task_triager"]);
const localNames = new Set(local);
const unexpected = remote.filter((name) => !localNames.has(name) && !allowedRemoteOnly.has(name));
if (unexpected.length) throw new Error(`Remote MCP catalog has unmapped business tools: ${unexpected.join(", ")}`);
for (const name of allowedRemoteOnly) {
  if (!remoteNames.has(name)) throw new Error(`Remote MCP catalog is missing required contract exception: ${name}`);
}

const unauthenticated = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mermail-cli-contract", version: "0.1.0" } } })
});
if (unauthenticated.status !== 401) throw new Error(`Unauthenticated MCP returned HTTP ${unauthenticated.status}, expected 401`);
console.log(`Validated ${local.length} CLI operations against ${remote.length} advertised tools; only prepare_destructive_action and set_default_task_triager are remote-only.`);
