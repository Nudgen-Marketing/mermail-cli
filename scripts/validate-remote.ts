import { operations } from "../src/operations.js";

const baseUrl = (process.env.MERMAIL_BASE_URL ?? "https://console.mermail.app").replace(/\/+$/, "");
const cardResponse = await fetch(`${baseUrl}/.well-known/mcp/server-card.json`);
if (!cardResponse.ok) throw new Error(`Server card returned HTTP ${cardResponse.status}`);
const card = await cardResponse.json() as any;
const remote = (card.capabilities?.tools?.list ?? []).filter((name: string) => name !== "prepare_destructive_action").sort();
const local = operations.map((operation) => operation.tool).sort();
if (JSON.stringify(remote) !== JSON.stringify(local)) throw new Error(`Remote MCP catalog drift: expected ${local.length}, found ${remote.length}`);

const unauthenticated = await fetch(`${baseUrl}/mcp`, {
  method: "POST",
  headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mermail-cli-contract", version: "0.1.0" } } })
});
if (unauthenticated.status !== 401) throw new Error(`Unauthenticated MCP returned HTTP ${unauthenticated.status}, expected 401`);
console.log(`Validated ${local.length} remote business tools and unauthenticated MCP rejection.`);
