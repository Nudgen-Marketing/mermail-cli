import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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

const tools = Array.from({ length: 63 }, (_, i) => ({
  name: i === 0 ? "prepare_destructive_action" : `tool_${i}`,
}));

let baseUrl = "";
let lastApiKey: string | null = null;
let authMode: "ok" | "unauthorized" = "ok";
let toolCount = 63;
let cardStatus = 200;

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  lastApiKey = req.headers["x-api-key"]?.toString() ?? null;

  if (url.pathname === "/.well-known/mcp/server-card.json") {
    if (cardStatus !== 200) {
      sendJson(res, cardStatus, { error: "unavailable" });
      return;
    }
    sendJson(res, 200, {
      serverInfo: { name: "Mermail MCP", version: "1.0.0" },
      transport: { protocol: "streamable-http", endpoint: `${baseUrl}/mcp` },
      authentication: [{ type: "api-key", header: "x-api-key", prefix: "sk-proj-" }],
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
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id,
        result: { tools: tools.slice(0, toolCount) },
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
    expect(body.telemetry).toBe("disabled");
  });

  it("reports discovery HTTP failure when card returns an error", async () => {
    cardStatus = 503;
    const result = await cli(["doctor", "--base-url", baseUrl, "--format", "json"]);
    expect(result.status).not.toBe(0);
    cardStatus = 200;
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
  it("requires exactly 63 tools", async () => {
    toolCount = 63;
    const result = await cli(
      ["mcp", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.connected).toBe(true);
    expect(body.tools).toBe(63);
    expect(body.server.name).toBe("mermail");
  });

  it("fails when tool count mismatches", async () => {
    toolCount = 10;
    const result = await cli(
      ["mcp", "check", "--base-url", baseUrl, "--api-key", "sk-proj-test", "--format", "json"],
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Expected 63 MCP tools");
    toolCount = 63;
  });
});
