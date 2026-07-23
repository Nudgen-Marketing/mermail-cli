import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

let baseUrl = "";
let searchCount = 0;
let lastSearch: URL | undefined;
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/v1/mailboxes/agent%40mermail.app/search") {
    searchCount += 1;
    lastSearch = url;
    if (searchCount === 1 || url.searchParams.get("subject") === "Never arrives") {
      sendJson(res, 200, { emails: [], totalCount: 0 });
      return;
    }
    sendJson(res, 200, {
      emails: [{
        id: "msg_verify",
        sender: "account@example.com",
        subject: "Verify your account",
        date: "2026-07-23T10:00:00.000Z",
        snippet: "Your code is 123456",
      }],
      totalCount: 1,
    });
    return;
  }
  if (url.pathname === "/api/v1/mailboxes/agent%40mermail.app/emails/msg_verify") {
    sendJson(res, 200, {
      id: "msg_verify",
      sender: "account@example.com",
      subject: "Verify your account",
      body: "Your verification code is 123456",
    });
    return;
  }
  sendJson(res, 404, { error: "not_found" });
});

function cli(args: string[]) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const env = { ...process.env };
    delete env.MERMAIL_API_KEY;
    const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
      cwd: process.cwd(),
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to bind mock server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("mailbox-first CLI workflow", () => {
  it("polls a narrow search and returns the full matching verification email", async () => {
    searchCount = 0;
    lastSearch = undefined;
    const result = await cli([
      "emails", "wait",
      "--mailbox-id", "agent@mermail.app",
      "--from", "account@example.com",
      "--subject", "Verify",
      "--after", "2026-07-23T09:55:00Z",
      "--poll-interval", "250",
      "--wait-timeout", "2000",
      "--base-url", baseUrl,
      "--api-key", "sk-proj-test",
      "--format", "json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(searchCount).toBe(2);
    const searchParams = (lastSearch as URL | undefined)?.searchParams;
    expect(searchParams?.get("from")).toBe("account@example.com");
    expect(searchParams?.get("subject")).toBe("Verify");
    expect(searchParams?.get("date_start")).toBe("2026-07-23T09:55:00.000Z");
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "msg_verify",
      body: "Your verification code is 123456",
    });
  });

  it("returns a stable timeout error when no matching email arrives", async () => {
    searchCount = 0;
    const result = await cli([
      "emails", "wait",
      "--mailbox-id", "agent@mermail.app",
      "--subject", "Never arrives",
      "--poll-interval", "250",
      "--wait-timeout", "100",
      "--base-url", baseUrl,
      "--api-key", "sk-proj-test",
      "--format", "json",
    ]);

    expect(result.status).toBe(5);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr).error).toMatchObject({
      status: 408,
      code: "email_wait_timeout",
    });
  });
});
