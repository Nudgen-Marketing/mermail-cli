import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError, resolveClientOptions, type ApiRequestInput } from "../src/client.js";
import {
  DEFAULT_EMAIL_POLL_INTERVAL,
  DEFAULT_EMAIL_WAIT_TIMEOUT,
  ensureMailbox,
  waitForEmail,
} from "../src/workflows.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = resolveClientOptions({ apiKey: "sk-proj-test" });

describe("email wait workflow", () => {
  it("starts only four default searches while time remains before the hard 120-second boundary", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => Response.json({ emails: [], totalCount: 0 }));
    vi.stubGlobal("fetch", fetchMock);
    let now = 0;

    const result = waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        waitTimeout: DEFAULT_EMAIL_WAIT_TIMEOUT,
        pollInterval: DEFAULT_EMAIL_POLL_INTERVAL,
      },
      {
        now: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      },
    );

    await expect(result).rejects.toMatchObject({ code: "email_wait_timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(now).toBe(120_000);
  });

  it("gives each HTTP call one attempt and only the remaining deadline budget", async () => {
    let now = 0;
    const inputs: ApiRequestInput[] = [];
    const request = vi.fn().mockImplementation(async (_client, input: ApiRequestInput) => {
      inputs.push(input);
      now += 120_000;
      return { data: { emails: [], totalCount: 0 }, response: Response.json({}) };
    });

    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        waitTimeout: 120_000,
        pollInterval: 30_000,
      },
      { now: () => now, sleep: async (milliseconds) => { now += milliseconds; }, request },
    )).rejects.toMatchObject({ code: "email_wait_timeout" });

    expect(request).toHaveBeenCalledTimes(1);
    expect(inputs[0]).toMatchObject({ maxAttempts: 1, budgetMs: 120_000 });
  });

  it("fails safely when a single-match workflow receives multiple candidates", async () => {
    const request = vi.fn().mockResolvedValue({
      data: {
        emails: [
          { id: "msg-1", sender: "verify@example.com", date: "2026-07-23T10:00:00Z" },
          { id: "msg-2", sender: "verify@example.com", date: "2026-07-23T10:00:01Z" },
        ],
        totalCount: 2,
      },
      response: Response.json({}),
    });

    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        fromExact: "verify@example.com",
        requireSingleMatch: true,
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).rejects.toMatchObject({ code: "email_wait_ambiguous", exitCode: 5 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("removes baseline Mermail ids and secondary provider message ids before ambiguity checks", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          emails: [
            {
              id: "msg-baseline",
              message_id: "<provider-old-primary@example.com>",
              sender: "verify@example.com",
              recipient: "agent@mermail.app",
              subject: "Verify account",
              date: "2026-07-23T10:00:00Z",
            },
            {
              id: "msg-old-secondary",
              message_id: "<provider-baseline@example.com>",
              sender: "verify@example.com",
              recipient: "agent@mermail.app",
              subject: "Verify account",
              date: "2026-07-23T10:00:01Z",
            },
            {
              id: "msg-new",
              message_id: "<provider-new@example.com>",
              sender: "verify@example.com",
              recipient: "agent@mermail.app",
              subject: "Verify account",
              date: "2026-07-23T10:00:02Z",
            },
          ],
          totalCount: 3,
        },
        response: Response.json({}),
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-new",
          message_id: "<provider-new@example.com>",
          sender: "verify@example.com",
          recipient: "agent@mermail.app",
          subject: "Verify account",
          date: "2026-07-23T10:00:02Z",
        },
        response: Response.json({}),
      });

    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        fromExact: "verify@example.com",
        toExact: "agent@mermail.app",
        subject: "Verify",
        excludeEmailIds: ["msg-baseline", "<provider-baseline@example.com>"],
        requireSingleMatch: true,
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).resolves.toMatchObject({ id: "msg-new" });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves the legacy full-message success shape when safe projection flags are omitted", async () => {
    const full = {
      id: "msg-legacy",
      sender: "verify@example.com",
      subject: "Verify account",
      body: "legacy full body",
      raw_headers: "[]",
      attachments: [{ id: "attachment-1" }],
    };
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: { emails: [{ id: "msg-legacy", sender: "verify@example.com", subject: "Verify account" }], totalCount: 1 },
        response: Response.json({}),
      })
      .mockResolvedValueOnce({ data: full, response: Response.json({}) });

    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        from: "verify",
        subject: "Verify",
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).resolves.toBe(full);
  });

  it("revalidates exact sender, recipient, time, and scan status before returning metadata", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: {
          emails: [{
            id: "msg-1",
            sender: "Example Verify <verify@example.com>",
            recipient: "other@example.com, Account Agent <agent@mermail.app>",
            subject: "Verify account",
            date: "2026-07-23T10:00:00Z",
          }],
          totalCount: 1,
        },
        response: Response.json({}),
      })
      .mockResolvedValueOnce({
        data: {
          id: "msg-1",
          sender: "Example Verify <verify@example.com>",
          recipient: "other@example.com, Account Agent <agent@mermail.app>",
          subject: "Verify account",
          date: "2026-07-23T10:00:00Z",
          body: "untrusted body",
          raw_headers: { authentication_results: "untrusted" },
          snippet: "untrusted snippet",
          scan_status: "clean",
          scan_threats: [{ url: "https://evil.example/token" }],
          attachments: [{ id: "attachment-1", filename: "run-me" }],
        },
        response: Response.json({}),
      });

    const result = await waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        fromExact: "verify@example.com",
        toExact: "agent@mermail.app",
        subject: "Verify",
        after: "2026-07-23T09:59:00.000Z",
        requireSingleMatch: true,
        requireScanStatus: "clean",
        rejectFlagged: true,
        metadataOnly: true,
        includeHeld: true,
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    );

    expect(result).toMatchObject({
      id: "msg-1",
      sender: "Example Verify <verify@example.com>",
      scan_status: "clean",
      content_omitted: true,
      attachment_count: 1,
    });
    expect(result).not.toHaveProperty("body");
    expect(result).not.toHaveProperty("raw_headers");
    expect(result).not.toHaveProperty("snippet");
    expect(result).not.toHaveProperty("scan_threats");
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      query: {
        from: "verify@example.com",
        to: "agent@mermail.app",
        require_scan_status: "clean",
        metadata_only: "true",
        include_held: "true",
      },
    });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      query: {
        metadata_only: "true",
        include_held: "true",
      },
    });
  });

  it("rejects flagged mail before returning it", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: { emails: [{ id: "msg-1", subject: "Verify" }], totalCount: 1 },
        response: Response.json({}),
      })
      .mockResolvedValueOnce({
        data: { id: "msg-1", subject: "Verify", scan_status: "flagged" },
        response: Response.json({}),
      });

    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        rejectFlagged: true,
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).rejects.toMatchObject({ code: "email_wait_flagged", exitCode: 5 });
  });

  it("returns a stable error when the required scan status does not match", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({
        data: { emails: [{ id: "msg-1", subject: "Verify" }], totalCount: 1 },
        response: Response.json({}),
      })
      .mockResolvedValueOnce({
        data: { id: "msg-1", subject: "Verify", scan_status: "skipped" },
        response: Response.json({}),
      });
    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        requireScanStatus: "clean",
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).rejects.toMatchObject({ code: "email_wait_scan_status_mismatch", exitCode: 5 });
  });

  it("returns a stable invalid-response error instead of timing out", async () => {
    const request = vi.fn().mockResolvedValue({
      data: { unexpected: true },
      response: Response.json({}),
    });
    await expect(waitForEmail(
      client,
      {
        mailboxId: "agent@mermail.app",
        subject: "Verify",
        waitTimeout: 1_000,
        pollInterval: 250,
      },
      { request },
    )).rejects.toMatchObject({ code: "email_wait_invalid_response", exitCode: 5 });
  });
});

describe("mailbox ensure workflow", () => {
  it("reuses one exact usable mailbox without creating", async () => {
    const mailbox = {
      public_id: "mailbox-1",
      email: "agent@mermail.app",
      inbound_provider: "cloudflare_routing",
      can_receive: true,
      receiving_status: "ready",
      disabled_at: null,
    };
    const request = vi.fn().mockResolvedValue({ data: [mailbox], response: Response.json({}) });
    await expect(ensureMailbox(client, { email: "AGENT@mermail.app" }, request)).resolves.toEqual({
      mailbox,
      created: false,
      resolution: "existing",
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("creates a verification mailbox once with workspace optional", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [], response: Response.json({}) })
      .mockResolvedValueOnce({
        data: { public_id: "mailbox-1", email: "agent@mermail.app" },
        response: Response.json({ status: 201 }),
      });

    const result = await ensureMailbox(client, {
      email: "agent@mermail.app",
      name: "Account Agent",
      verificationMode: true,
      idempotencyKey: "ensure-agent",
    }, request);

    expect(result).toMatchObject({ created: true, resolution: "created" });
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      maxAttempts: 1,
      idempotencyKey: "ensure-agent",
      body: {
        email: "agent@mermail.app",
        name: "Account Agent",
        settings: {
          agentInbox: {
            mode: "verification",
            automationsEnabled: false,
          },
        },
      },
    });
    expect((request.mock.calls[1]?.[1].body as Record<string, unknown>)).not.toHaveProperty("workspaceId");
  });

  it("derives idempotency keys from workspace context, normalized address, and purpose", async () => {
    const captured: string[] = [];
    const makeRequest = () => vi.fn()
      .mockResolvedValueOnce({ data: [], response: Response.json({}) })
      .mockImplementationOnce(async (_client, input: ApiRequestInput) => {
        captured.push(String(input.idempotencyKey));
        return {
          data: { public_id: "mailbox-1", email: "agent@mermail.app" },
          response: Response.json({ status: 201 }),
        };
      });

    await ensureMailbox(client, {
      email: "AGENT@MERMAIL.APP",
      name: "Account Agent",
      verificationMode: true,
    }, makeRequest());
    await ensureMailbox(client, {
      email: "agent@mermail.app",
      name: "Account Agent",
      verificationMode: true,
      workspaceId: "workspace-1",
    }, makeRequest());
    await ensureMailbox(client, {
      email: "AGENT@mermail.app",
      name: "Account Agent",
      verificationMode: true,
      workspaceId: "workspace-1",
    }, makeRequest());
    await ensureMailbox(client, {
      email: "agent@mermail.app",
      name: "Account Agent",
      verificationMode: true,
      workspaceId: "workspace-2",
    }, makeRequest());

    expect(captured).toHaveLength(4);
    expect(captured[0]).not.toBe(captured[1]);
    expect(captured[1]).toBe(captured[2]);
    expect(captured[1]).not.toBe(captured[3]);
    expect(captured[0]).toMatch(/^mailbox-ensure-v1-[a-f0-9]{40}$/);
  });

  it("re-lists once after a create conflict and reuses the winner", async () => {
    const mailbox = {
      public_id: "mailbox-race",
      email: "agent@mermail.app",
      can_receive: true,
      receiving_status: "ready",
      disabled_at: null,
    };
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [], response: Response.json({}) })
      .mockRejectedValueOnce(new CliError("already exists", 1, 409, "conflict"))
      .mockResolvedValueOnce({ data: [mailbox], response: Response.json({}) });

    await expect(ensureMailbox(client, {
      email: "agent@mermail.app",
      name: "Account Agent",
    }, request)).resolves.toEqual({
      mailbox,
      created: false,
      resolution: "conflict_relisted",
    });
    expect(request.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(1);
  });

  it("discovers a fully verified custom domain before creating", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [], response: Response.json({}) })
      .mockResolvedValueOnce({
        data: [{
          domain: "mail.example.com",
          status: "partially_verified",
          can_send: true,
          can_receive: true,
        }],
        response: Response.json({}),
      })
      .mockResolvedValueOnce({
        data: { public_id: "mailbox-custom", email: "agent@mail.example.com" },
        response: Response.json({ status: 201 }),
      });

    await expect(ensureMailbox(client, {
      email: "agent@mail.example.com",
      name: "Custom Agent",
      workspaceId: "workspace-1",
    }, request)).resolves.toMatchObject({ created: true });
    expect(request.mock.calls[1]?.[1].path).toBe("/api/v1/workspaces/workspace-1/email-domains");
    expect(request.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: {
        email: "agent@mail.example.com",
        name: "Custom Agent",
        workspaceId: "workspace-1",
      },
    });
  });

  it("does not let a legacy verified status override current receiving readiness", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [], response: Response.json({}) })
      .mockResolvedValueOnce({
        data: [{
          domain: "mail.example.com",
          status: "verified",
          can_send: true,
          can_receive: false,
        }],
        response: Response.json({}),
      });

    await expect(ensureMailbox(client, {
      email: "agent@mail.example.com",
      name: "Custom Agent",
      workspaceId: "workspace-1",
    }, request)).rejects.toMatchObject({
      code: "mailbox_domain_unavailable",
    });
    expect(request.mock.calls.filter((call) => call[1].method === "POST")).toHaveLength(0);
  });

  it("does not reuse an explicitly disabled mailbox", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{
        public_id: "mailbox-disabled",
        email: "agent@mermail.app",
        disabled_at: "2026-07-23T10:00:00Z",
        receiving_status: "disabled",
      }],
      response: Response.json({}),
    });
    await expect(ensureMailbox(client, { email: "agent@mermail.app" }, request))
      .rejects.toMatchObject({ code: "mailbox_ensure_unusable" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not silently reuse a standard mailbox for verification mode", async () => {
    const request = vi.fn().mockResolvedValue({
      data: [{
        public_id: "mailbox-standard",
        email: "agent@mermail.app",
        can_receive: true,
        receiving_status: "ready",
        disabled_at: null,
        settings: {
          agentInbox: {
            mode: "standard",
            automationsEnabled: true,
          },
        },
      }],
      response: Response.json({}),
    });
    await expect(ensureMailbox(client, {
      email: "agent@mermail.app",
      verificationMode: true,
    }, request)).rejects.toMatchObject({ code: "mailbox_ensure_purpose_mismatch" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
