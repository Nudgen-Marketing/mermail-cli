import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operations } from "../src/operations.js";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const listEmailsInputSchema = {
  type: "object",
  properties: {
    mailboxId: { type: "string" },
    query: {
      type: "object",
      properties: {
        folder: { type: ["string", "null"] },
        sortColumn: { type: ["string", "null"] },
        sortDirection: { type: ["string", "null"] },
      },
    },
  },
};
const tools = [
  "prepare_destructive_action",
  ...operations.map((operation) => operation.tool),
  "future_additive_tool",
].map((name) => ({
  name,
  inputSchema: name === "list_emails"
    ? listEmailsInputSchema
    : { type: "object", properties: {} },
}));
const agentInboxTools = new Set([
  "get_api_credit_usage",
  "list_workspaces",
  "get_workspace",
  "list_email_domains",
  "list_workspace_mailboxes",
  "list_mailboxes",
  "create_mailbox",
  "get_mailbox",
  "list_emails",
  "search_emails",
  "get_email",
]);

let baseUrl = "";
let lastApiKey: string | null = null;
let lastMcpProfile: string | null = null;
let authMode: "ok" | "unauthorized" = "ok";
let omittedTool: string | undefined;
let includeExtraTool = false;
let includeUnexpectedProfileTool = false;
let incompatibleListEmailsSchema = false;
let cardStatus = 200;
let cardMode: "valid" | "invalid" = "valid";

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  lastApiKey = req.headers["x-api-key"]?.toString() ?? null;

  if (url.pathname === "/.well-known/mcp/server-card.json") {
    if (cardStatus !== 200) {
      sendJson(res, cardStatus, { error: "unavailable" });
      return;
    }
    if (cardMode === "invalid") {
      sendJson(res, 200, { serverInfo: { name: "Mermail MCP" } });
      return;
    }
    sendJson(res, 200, {
      serverInfo: { name: "Mermail MCP", version: "1.0.0" },
      transport: { protocol: "streamable-http", endpoint: `${baseUrl}/mcp` },
      authentication: [
        { type: "oauth2", authorization_servers: [baseUrl] },
        { type: "api-key", header: "x-api-key", prefix: "sk-proj-" },
      ],
      capabilities: { tools: { list: tools.map((t) => t.name) } },
    });
    return;
  }

  if (url.pathname === "/api/v1/workspaces") {
    if (authMode === "unauthorized") {
      sendJson(res, 401, { error: "Unauthorized", code: "unauthorized" });
      return;
    }
    sendJson(res, 200, { workspaces: [{ id: "ws-1", name: "Demo" }] });
    return;
  }

  if (url.pathname === "/mcp" && req.method === "POST") {
    lastMcpProfile = url.searchParams.get("profile");
    const raw = await readBody(req);
    const body = JSON.parse(raw) as { id: number; method: string };
    if (body.method === "initialize") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { serverInfo: { name: "mermail", title: "Mermail MCP", version: "1.0.0" } },
      });
      return;
    }
    if (body.method === "tools/list") {
      const listedTools = tools.filter((tool) =>
        tool.name !== omittedTool
        && (includeExtraTool || tool.name !== "future_additive_tool")
        && (
          lastMcpProfile !== "agent-inbox"
          || agentInboxTools.has(tool.name)
          || (includeUnexpectedProfileTool && tool.name === "future_additive_tool")
        )
      ).map((tool) => incompatibleListEmailsSchema && tool.name === "list_emails"
        ? {
            ...tool,
            inputSchema: {
              type: "object",
              properties: {
                mailboxId: { type: "string" },
                query: { type: "string" },
              },
            },
          }
        : tool);
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: listedTools },
      });
      return;
    }
    sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: {} });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

function cli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    delete env.MERMAIL_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: process.cwd(),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind mock server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("CLI doctor", () => {
  it("reports discovery ok without an API key", async () => {
    const result = await cli(["doctor", "--base-url", baseUrl, "--format", "json"]);
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.discovery).toBe("ok");
    expect(body.apiKey).toBe("missing");
    expect(body.baseUrl).toBe(baseUrl);
    expect(body.toolCount).toBe(64);
    expect(body.hasListEmails).toBe(true);
    expect(body.authModes).toEqual(["oauth2", "api-key"]);
    expect(body.telemetry).toBe("disabled");
  });

  it("reports discovery HTTP failure when card returns an error", async () => {
    cardStatus = 503;
    const result = await cli(["doctor", "--base-url", baseUrl, "--format", "json"]);
    expect(result.status).not.toBe(0);
    cardStatus = 200;
  });

  it("fails when the discovery card cannot be parsed as an MCP catalog", async () => {
    cardMode = "invalid";
    const result = await cli(["doctor", "--base-url", baseUrl, "--format", "json"]);
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error.message).toContain("invalid MCP server card");
    cardMode = "valid";
  });
});

describe("CLI auth check", () => {
  it("validates an API key against workspaces", async () => {
    authMode = "ok";
    const result = await cli(
      ["auth", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).toBe(0);
    expect(lastApiKey).toBe("sk-proj-test");
    const body = JSON.parse(result.stdout);
    expect(body.authenticated).toBe(true);
    expect(body.workspaces.workspaces[0].id).toBe("ws-1");
  });

  it("exits with code 3 on unauthorized API key", async () => {
    authMode = "unauthorized";
    const result = await cli(
      ["auth", "check", "--base-url", baseUrl, "--api-key", "sk-proj-bad", "--format", "json"],
    );
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("unauthorized");
    authMode = "ok";
  });
});

describe("CLI mcp check", () => {
  it("accepts the required tool set plus future additive tools", async () => {
    omittedTool = undefined;
    includeExtraTool = true;
    const result = await cli(
      ["mcp", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.connected).toBe(true);
    expect(body.tools).toBe(64);
    expect(body.server.name).toBe("mermail");
    expect(body.profile).toBe("full");
    expect(body.listEmailsSchema).toBe("compatible");
    includeExtraTool = false;
  });

  it("checks the additive agent-inbox profile without requiring the full catalog", async () => {
    const result = await cli(
      ["mcp", "check", "--profile", "agent-inbox", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(lastMcpProfile).toBe("agent-inbox");
    expect(body).toMatchObject({
      connected: true,
      tools: 11,
      profile: "agent-inbox",
      listEmailsSchema: "compatible",
    });
  });

  it("rejects unexpected tools in the least-privilege agent-inbox profile", async () => {
    includeExtraTool = true;
    includeUnexpectedProfileTool = true;
    const result = await cli(
      ["mcp", "check", "--profile", "agent-inbox", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "mcp_profile_mismatch",
      details: {
        expected: 11,
        discovered: 12,
        unexpected: ["future_additive_tool"],
      },
    });
    includeExtraTool = false;
    includeUnexpectedProfileTool = false;
  });

  it("fails with a stable error when a required tool is missing", async () => {
    omittedTool = "get_email";
    const result = await cli(
      ["mcp", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "mcp_missing_tools",
      details: { missing: ["get_email"] },
    });
    omittedTool = undefined;
  });

  it("fails when list_emails query is not a structured compatible object", async () => {
    incompatibleListEmailsSchema = true;
    const result = await cli(
      ["mcp", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).not.toBe(0);
    expect(JSON.parse(result.stderr).error).toMatchObject({
      code: "mcp_incompatible_tool_schema",
      details: {
        tool: "list_emails",
        missing: ["folder", "sortColumn", "sortDirection"],
      },
    });
    incompatibleListEmailsSchema = false;
  });
});
