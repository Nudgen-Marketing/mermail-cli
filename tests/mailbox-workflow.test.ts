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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

let baseUrl = "";
let searchCount = 0;
let lastSearch: URL | undefined;
let mailboxList: Record<string, unknown>[] = [];
let mailboxCreateCount = 0;
let lastMailboxCreate: Record<string, unknown> | undefined;
let lastIdempotencyKey: string | undefined;
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/v1/mailboxes" && req.method === "GET") {
    sendJson(res, 200, mailboxList);
    return;
  }
  if (url.pathname === "/api/v1/mailboxes" && req.method === "POST") {
    mailboxCreateCount += 1;
    lastMailboxCreate = JSON.parse(await readBody(req));
    lastIdempotencyKey = req.headers["idempotency-key"]?.toString();
    const mailbox = {
      public_id: "mailbox_agent",
      email: lastMailboxCreate?.email,
      name: lastMailboxCreate?.name,
      can_receive: true,
      receiving_status: "ready",
      disabled_at: null,
    };
    mailboxList = [mailbox];
    sendJson(res, 201, mailbox);
    return;
  }
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
        recipient: "agent@mermail.app",
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
      recipient: "agent@mermail.app",
      subject: "Verify your account",
      date: "2026-07-23T10:00:00.000Z",
      body: "Your verification code is 123456",
      scan_status: "clean",
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
  it("ensures a verification mailbox with one non-retried create", async () => {
    mailboxList = [];
    mailboxCreateCount = 0;
    lastMailboxCreate = undefined;
    lastIdempotencyKey = undefined;
    const result = await cli([
      "mailboxes", "ensure",
      "--email", "agent@mermail.app",
      "--name", "Account Agent",
      "--verification-mode",
      "--idempotency-key", "ensure-agent",
      "--base-url", baseUrl,
      "--api-key", "sk-proj-test",
      "--format", "json",
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(mailboxCreateCount).toBe(1);
    expect(lastIdempotencyKey).toBe("ensure-agent");
    expect(lastMailboxCreate).toMatchObject({
      email: "agent@mermail.app",
      name: "Account Agent",
      settings: {
        agentInbox: {
          mode: "verification",
          automationsEnabled: false,
        },
      },
    });
    expect(lastMailboxCreate).not.toHaveProperty("workspaceId");
    expect(JSON.parse(result.stdout)).toMatchObject({
      created: true,
      resolution: "created",
      mailbox: { public_id: "mailbox_agent" },
    });
  });

  it("polls a narrow search and returns the full matching verification email", async () => {
    searchCount = 0;
    lastSearch = undefined;
    const result = await cli([
      "emails", "wait",
      "--mailbox-id", "agent@mermail.app",
      "--from-exact", "account@example.com",
      "--to-exact", "agent@mermail.app",
      "--subject", "Verify",
      "--after", "2026-07-23T09:55:00Z",
      "--exclude-email-id", "msg-baseline-one",
      "--exclude-email-id", "msg-baseline-two",
      "--include-held",
      "--require-single-match",
      "--require-scan-status", "clean",
      "--reject-flagged",
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
    expect(searchParams?.get("to")).toBe("agent@mermail.app");
    expect(searchParams?.get("subject")).toBe("Verify");
    expect(searchParams?.get("date_start")).toBe("2026-07-23T09:55:00.000Z");
    expect(searchParams?.get("include_held")).toBe("true");
    expect(searchParams?.get("require_scan_status")).toBe("clean");
    expect(searchParams?.get("exclude_email_id")).toBeNull();
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "msg_verify",
      body: "Your verification code is 123456",
    });
  });

  it("maps additive hyphenated direct-search flags to snake_case API parameters", async () => {
    searchCount = 0;
    lastSearch = undefined;
    const result = await cli([
      "emails", "search",
      "--mailbox-id", "agent@mermail.app",
      "--subject", "Verify",
      "--require-scan-status", "clean",
      "--include-held",
      "--metadata-only",
      "--base-url", baseUrl,
      "--api-key", "sk-proj-test",
      "--format", "json",
    ]);

    expect(result.status).toBe(0);
    const searchParams = (lastSearch as URL | undefined)?.searchParams;
    expect(searchParams?.get("require_scan_status")).toBe("clean");
    expect(searchParams?.get("include_held")).toBe("true");
    expect(searchParams?.get("metadata_only")).toBe("true");
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
