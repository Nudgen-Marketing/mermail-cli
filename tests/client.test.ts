import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, CliError, resolveClientOptions } from "../src/client.js";

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

  it("fails before the network when no API key exists", async () => {
    vi.stubEnv("MERMAIL_API_KEY", "");
    await expect(apiRequest(resolveClientOptions({}), { method: "GET", path: "/api/v1/workspaces" })).rejects.toMatchObject({ exitCode: 3 });
  });

  it("sends x-api-key without logging its value", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = resolveClientOptions({ apiKey: "sk-proj-secret", debug: true });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await apiRequest(client, { method: "GET", path: "/api/v1/workspaces" });
    expect(fetchMock.mock.calls[0]?.[1]?.headers["x-api-key"]).toBe("sk-proj-secret");
    expect(stderr.mock.calls.flat().join(" ")).not.toContain("sk-proj-secret");
    stderr.mockRestore();
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
});
