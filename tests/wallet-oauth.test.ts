import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CliError, mcpRequest } from "../src/client.js";
import {
  clearOauthSession,
  loadOauthSession,
  parseScopes,
  redactOauthSession,
  saveOauthSession,
  sessionHasScopes,
} from "../src/oauth.js";
import { extractMcpToolResult, submitWalletTransfer } from "../src/wallet.js";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

describe("oauth helpers", () => {
  let configDir = "";

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "mermail-cli-oauth-"));
    process.env.MERMAIL_CONFIG_DIR = configDir;
  });

  afterEach(async () => {
    await clearOauthSession();
    delete process.env.MERMAIL_CONFIG_DIR;
    await rm(configDir, { recursive: true, force: true });
  });

  it("parses wallet scopes", () => {
    expect(parseScopes(undefined, true)).toEqual([
      "mcp:tools",
      "openid",
      "offline_access",
      "wallet:read",
      "wallet:transact",
    ]);
    expect(parseScopes("mcp:tools,wallet:read", false)).toEqual([
      "mcp:tools",
      "wallet:read",
    ]);
  });

  it("stores and redacts oauth sessions", async () => {
    await saveOauthSession({
      baseUrl: "https://console.mermail.app",
      clientId: "mcp_client_test",
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: Date.now() + 60_000,
      scopes: ["mcp:tools", "wallet:read"],
      resource: "https://console.mermail.app/mcp",
      updatedAt: new Date().toISOString(),
    });
    const loaded = await loadOauthSession("https://console.mermail.app");
    expect(loaded?.accessToken).toBe("access-secret");
    const redacted = redactOauthSession(loaded!);
    expect(JSON.stringify(redacted)).not.toContain("access-secret");
    expect(JSON.stringify(redacted)).not.toContain("refresh-secret");
    expect(sessionHasScopes(loaded!, ["wallet:transact"])).toEqual(["wallet:transact"]);
    const raw = await readFile(join(configDir, "mcp-oauth.json"), "utf8");
    expect(raw).toContain("access-secret");
  });
});

describe("mcpRequest oauth bearer", () => {
  it("sends bearer tokens without requiring an API key", async () => {
    let authHeader: string | undefined;
    const server = createServer((req, res) => {
      authHeader = req.headers.authorization;
      sendJson(res, 200, { jsonrpc: "2.0", id: 1, result: { ok: true } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const payload = await mcpRequest(
        { baseUrl: `http://127.0.0.1:${address.port}`, timeout: 5_000 },
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { auth: "oauth", accessToken: "mcp_at_test" },
      );
      expect(payload.result.ok).toBe(true);
      expect(authHeader).toBe("Bearer mcp_at_test");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("refreshes once on oauth 401", async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls += 1;
      if (calls === 1) {
        sendJson(res, 401, { error: { message: "expired", code: "invalid_token" } });
        return;
      }
      expect(req.headers.authorization).toBe("Bearer mcp_at_fresh");
      sendJson(res, 200, { jsonrpc: "2.0", id: 1, result: { ok: true } });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const payload = await mcpRequest(
        { baseUrl: `http://127.0.0.1:${address.port}`, timeout: 5_000 },
        { jsonrpc: "2.0", id: 1, method: "ping" },
        {
          auth: "oauth",
          accessToken: "mcp_at_stale",
          onUnauthorizedOauth: async () => "mcp_at_fresh",
        },
      );
      expect(payload.result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

describe("wallet mcp helpers", () => {
  it("extracts structured tool results and surfaces errors", () => {
    expect(
      extractMcpToolResult({
        result: { structuredContent: { connection: { status: "ACTIVE" } } },
      }),
    ).toEqual({ connection: { status: "ACTIVE" } });
    expect(() =>
      extractMcpToolResult({
        result: { isError: true, structuredContent: { error: "paybox_not_connected", code: "paybox_not_connected" } },
      }),
    ).toThrow(CliError);
  });

  it("requires --yes path to bind prepare then submit arguments exactly", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mermail-cli-wallet-"));
    process.env.MERMAIL_CONFIG_DIR = configDir;
    await saveOauthSession({
      baseUrl: "http://127.0.0.1",
      clientId: "mcp_client_test",
      accessToken: "mcp_at_test",
      refreshToken: "mcp_rt_test",
      expiresAt: Date.now() + 60_000,
      scopes: ["mcp:tools", "wallet:read", "wallet:transact"],
      resource: "http://127.0.0.1/mcp",
      updatedAt: new Date().toISOString(),
    });

    const calls: Array<{ name?: string; arguments?: Record<string, unknown> }> = [];
    const server = createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/mcp") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      if (body.method === "initialize") {
        sendJson(res, 200, { jsonrpc: "2.0", id: body.id, result: { serverInfo: { name: "mermail" } } });
        return;
      }
      if (body.method === "tools/list") {
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              { name: "prepare_destructive_action" },
              { name: "submit_agent_wallet_transfer" },
              { name: "get_agent_wallet" },
            ],
          },
        });
        return;
      }
      if (body.method === "tools/call") {
        calls.push({ name: body.params?.name, arguments: body.params?.arguments });
        if (body.params?.name === "prepare_destructive_action") {
          sendJson(res, 200, {
            jsonrpc: "2.0",
            id: body.id,
            result: { structuredContent: { confirmationToken: "mcp_confirm_test" } },
          });
          return;
        }
        sendJson(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: { structuredContent: { status: "SUCCEEDED", proposalId: "proposal-1" } },
        });
        return;
      }
      sendJson(res, 400, { error: "unexpected" });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    await saveOauthSession({
      baseUrl,
      clientId: "mcp_client_test",
      accessToken: "mcp_at_test",
      refreshToken: "mcp_rt_test",
      expiresAt: Date.now() + 60_000,
      scopes: ["mcp:tools", "wallet:read", "wallet:transact"],
      resource: `${baseUrl}/mcp`,
      updatedAt: new Date().toISOString(),
    });

    try {
      const result = await submitWalletTransfer({
        client: { baseUrl, timeout: 5_000 },
        cliVersion: "0.0.0-test",
        proposalId: "proposal-1",
        version: 2,
        confirmationDestination: "0xabc",
        acknowledgeIrreversibleMainnetTransfer: true,
      });
      expect(result).toMatchObject({ status: "SUCCEEDED", completed: true });
      const prepare = calls.find((call) => call.name === "prepare_destructive_action");
      const submit = calls.find((call) => call.name === "submit_agent_wallet_transfer");
      expect(prepare?.arguments).toEqual({
        action: "submit_agent_wallet_transfer",
        arguments: {
          proposalId: "proposal-1",
          version: 2,
          confirmationDestination: "0xabc",
          acknowledgeIrreversibleMainnetTransfer: true,
        },
      });
      expect(submit?.arguments).toEqual({
        proposalId: "proposal-1",
        version: 2,
        confirmationDestination: "0xabc",
        acknowledgeIrreversibleMainnetTransfer: true,
        confirmationToken: "mcp_confirm_test",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await clearOauthSession();
      delete process.env.MERMAIL_CONFIG_DIR;
      await rm(configDir, { recursive: true, force: true });
    }
  });

  it("fails wallet calls without oauth session", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mermail-cli-wallet-missing-"));
    process.env.MERMAIL_CONFIG_DIR = configDir;
    await clearOauthSession();
    await expect(
      submitWalletTransfer({
        client: { baseUrl: "https://console.mermail.app", timeout: 5_000 },
        cliVersion: "0.0.0-test",
        proposalId: "proposal-1",
        version: 1,
        confirmationDestination: "0xabc",
        acknowledgeIrreversibleMainnetTransfer: true,
      }),
    ).rejects.toMatchObject({ code: "oauth_required", exitCode: 3 });
    delete process.env.MERMAIL_CONFIG_DIR;
    await rm(configDir, { recursive: true, force: true });
  });
});
