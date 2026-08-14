import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, CliError, resolveClientOptions, retryDelay } from "../src/client.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("client", () => {
  it("uses the production URL by default", () => {
    vi.stubEnv("MERMAIL_BASE_URL", "");
    expect(resolveClientOptions({}).baseUrl).toBe("https://console.mermail.app");
  });

  it("prefers an explicit API key over the environment", () => {
    vi.stubEnv("MERMAIL_API_KEY", "sk-proj-env");
    expect(resolveClientOptions({ apiKey: "sk-proj-flag" }).apiKey).toBe("sk-proj-flag");
  });

  it("rejects insecure non-local endpoints", () => {
    expect(() => resolveClientOptions({ baseUrl: "http://example.com" })).toThrow(CliError);
  });

  it("validates malformed URLs and timeout bounds", () => {
    expect(() => resolveClientOptions({ baseUrl: "not a url" })).toThrow(CliError);
    expect(() => resolveClientOptions({ baseUrl: "https://user:secret@example.com" })).toThrow(CliError);
    expect(() => resolveClientOptions({ timeout: "nope" })).toThrow(CliError);
    expect(() => resolveClientOptions({ timeout: "99" })).toThrow(CliError);
  });

  it("parses the full Retry-After value so callers can compare it with their budget", () => {
    expect(retryDelay("2", 0, 0)).toBe(2000);
    expect(retryDelay("Thu, 01 Jan 1970 00:00:05 GMT", 0, 0)).toBe(5000);
    expect(retryDelay("999", 0, 0)).toBe(999000);
  });

  it("fails before the network when no API key exists", async () => {
    vi.stubEnv("MERMAIL_API_KEY", "");
    await expect(apiRequest(resolveClientOptions({}), { method: "GET", path: "/api/v1/workspaces" })).rejects.toMatchObject({ exitCode: 3 });
  });

  it("sends x-api-key without logging credentials, path identifiers, or query values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = resolveClientOptions({ apiKey: "sk-proj-secret", debug: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await apiRequest(client, {
      method: "GET",
      path: "/api/v1/mailboxes/private-agent@example.com/search",
      query: { subject: "secret-code-123" },
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers["x-api-key"]).toBe("sk-proj-secret");
    const debug = stderr.mock.calls.flat().join(" ");
    expect(debug).not.toContain("sk-proj-secret");
    expect(debug).not.toContain("private-agent@example.com");
    expect(debug).not.toContain("secret-code-123");
    expect(debug).toContain("queryParameters=1");
    stderr.mockRestore();
  });

  it("does not retry past the request budget and surfaces Retry-After", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(
      { error: "Too many requests", code: "rate_limited" },
      { status: 429, headers: { "retry-after": "120" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest(
      resolveClientOptions({ apiKey: "sk-proj-test", timeout: "30000" }),
      { method: "GET", path: "/api/v1/workspaces" },
    )).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      retryAfterMs: 120_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes malformed JSON responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    await expect(apiRequest(
      resolveClientOptions({ apiKey: "sk-proj-test" }),
      { method: "GET", path: "/api/v1/workspaces" },
    )).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });

  it("normalizes authentication errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "api_key_revoked" }, { status: 401 })));
    await expect(apiRequest(resolveClientOptions({ apiKey: "sk-proj-test" }), { method: "GET", path: "/api/v1/workspaces" })).rejects.toMatchObject({ exitCode: 3, status: 401, code: "api_key_revoked" });
  });

  it("does not retry writes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ error: "temporary" }, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest(resolveClientOptions({ apiKey: "sk-proj-test" }), { method: "POST", path: "/api/v1/mailboxes", body: {} })).rejects.toBeInstanceOf(CliError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces external email recipient Retry-After without replaying the write", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(
      { error: "email_send_rate_limit_exceeded", code: "email_send_rate_limit_exceeded" },
      { status: 429, headers: { "retry-after": "42" } },
    ));
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest(
      resolveClientOptions({ apiKey: "sk-proj-test" }),
      { method: "POST", path: "/api/v1/mailboxes/mailbox-1/emails", body: { to: "a@example.com" } },
    )).rejects.toMatchObject({
      status: 429,
      code: "email_send_rate_limit_exceeded",
      retryAfterMs: 42_000,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
