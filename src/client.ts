import { setTimeout as delay } from "node:timers/promises";

export class CliError extends Error {
  constructor(
    message: string,
    public readonly exitCode = 1,
    public readonly status?: number,
    public readonly code?: string,
    public readonly details?: unknown,
    public readonly requestId?: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type ClientOptions = { apiKey?: string; baseUrl: string; timeout: number; debug?: boolean };
export type ApiRequestInput = {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  idempotencyKey?: string;
  maxAttempts?: number;
  budgetMs?: number;
};

export function resolveClientOptions(options: Record<string, unknown>): ClientOptions {
  const apiKey = String(options.apiKey || process.env.MERMAIL_API_KEY || "").trim() || undefined;
  const baseUrl = String(options.baseUrl || process.env.MERMAIL_BASE_URL || "https://console.mermail.app").replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new CliError("Base URL is not a valid URL", 2); }
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new CliError("Base URL must use HTTPS except for localhost", 2);
  if (url.username || url.password) throw new CliError("Base URL must not contain credentials", 2);
  const timeout = Number(options.timeout || 30_000);
  if (!Number.isSafeInteger(timeout) || timeout < 100 || timeout > 300_000) throw new CliError("Timeout must be an integer between 100 and 300000 milliseconds", 2);
  return { apiKey, baseUrl, timeout, debug: Boolean(options.debug) };
}

export async function apiRequest(client: ClientOptions, input: ApiRequestInput): Promise<{ data: unknown; response: Response }> {
  if (!client.apiKey) throw new CliError("MERMAIL_API_KEY is not set. Export it or pass --api-key.", 3, 401, "api_key_required");
  const url = new URL(input.path, client.baseUrl);
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.append(key, value);
  const headers: Record<string, string> = { accept: "application/json", "x-api-key": client.apiKey };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
  const attempts = input.maxAttempts ?? (input.method === "GET" ? 3 : 1);
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 10) throw new CliError("maxAttempts must be an integer between 1 and 10", 2);
  const budgetMs = Math.min(client.timeout, input.budgetMs ?? client.timeout);
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw requestTimeout();
  const startedAt = performance.now();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = budgetMs - (performance.now() - startedAt);
    if (remaining <= 0) throw requestTimeout();
    try {
      if (client.debug) process.stderr.write(`${debugRequest(input.method, url, attempt + 1, attempts)}\n`);
      const response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(Math.max(1, Math.floor(remaining))),
      });
      if ([408, 429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        const retryAfter = retryDelay(response.headers.get("retry-after"), attempt);
        const retryBudget = budgetMs - (performance.now() - startedAt);
        if (retryAfter < retryBudget) {
          await delay(retryAfter);
          continue;
        }
      }
      const data = await readResponse(response);
      if (!response.ok) {
        const body = isRecord(data) ? data : {};
        const error = typeof body.error === "string" ? body.error : undefined;
        const code = typeof body.code === "string" ? body.code : error;
        const message = typeof body.message === "string" ? body.message : error;
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
        throw new CliError(
          message ?? `HTTP ${response.status}`,
          response.status === 401 ? 3 : 1,
          response.status,
          code,
          body.details,
          response.headers.get("x-request-id") ?? undefined,
          retryAfterMs,
        );
      }
      return { data, response };
    } catch (error) {
      lastError = error;
      if (error instanceof CliError) throw error;
      if (isTimeoutError(error)) throw requestTimeout(error);
      if (attempt + 1 >= attempts) throw error;
      const retryAfter = retryDelay(null, attempt);
      const retryBudget = budgetMs - (performance.now() - startedAt);
      if (retryAfter >= retryBudget) throw requestTimeout(error);
      await delay(retryAfter);
    }
  }
  throw lastError;
}

export function retryDelay(header: string | null, attempt: number, now = Date.now()) {
  if (header) {
    const seconds = Number(header);
    const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return Math.min(250 * 2 ** attempt + Math.random() * 100, 30_000);
}

function parseRetryAfter(header: string | null, now = Date.now()) {
  if (!header) return undefined;
  const seconds = Number(header);
  const value = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

async function readResponse(response: Response): Promise<unknown> {
  if (response.status === 204) return { ok: true, status: 204 };
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("json")) return new Uint8Array(await response.arrayBuffer());
  try {
    return await response.json();
  } catch {
    throw new CliError(
      `API returned invalid JSON with HTTP ${response.status}`,
      1,
      response.status,
      "invalid_response",
      undefined,
      response.headers.get("x-request-id") ?? undefined,
    );
  }
}

function requestTimeout(cause?: unknown) {
  return new CliError(
    "Request exceeded its timeout budget",
    1,
    408,
    "request_timeout",
    cause instanceof Error ? { cause: cause.name } : undefined,
  );
}

function debugRequest(method: string, url: URL, attempt: number, attempts: number) {
  const route = url.pathname.startsWith("/api/v1/")
    ? "/api/v1/<redacted>"
    : url.pathname.startsWith("/api/agent/")
      ? "/api/agent/<redacted>"
      : url.pathname;
  const query = url.searchParams.size ? ` queryParameters=${url.searchParams.size}` : "";
  return `[debug] ${method} ${url.origin}${route}${query} attempt=${attempt}/${attempts}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTimeoutError(error: unknown) {
  return error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name);
}

export type McpAuthMode = "api_key" | "oauth";

export type McpRequestOptions = {
  profile?: string;
  accessToken?: string;
  auth?: McpAuthMode;
  onUnauthorizedOauth?: () => Promise<string | null>;
};

export async function mcpRequest(
  client: ClientOptions,
  body: unknown,
  options: McpRequestOptions = {},
): Promise<any> {
  const preferOauth = Boolean(options.accessToken) || options.auth === "oauth";
  let accessToken = options.accessToken;
  if (preferOauth && !accessToken) {
    throw new CliError(
      "MCP OAuth access token required. Run `mermail auth login --wallet`.",
      3,
      401,
      "oauth_required",
    );
  }
  if (!preferOauth && !client.apiKey) {
    throw new CliError("MERMAIL_API_KEY is not set. Export it or pass --api-key.", 3, 401, "api_key_required");
  }

  const url = new URL(`${client.baseUrl}/mcp`);
  if (options.profile) url.searchParams.set("profile", options.profile);

  const send = async (token?: string) => {
    const headers: Record<string, string> = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    else if (client.apiKey) headers["x-api-key"] = client.apiKey;
    if (client.debug) {
      process.stderr.write(
        `[debug] POST ${url.origin}/mcp auth=${token ? "oauth" : "api_key"}${options.profile ? ` profile=${options.profile}` : ""}\n`,
      );
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(client.timeout),
    });
    const payload = await response.json().catch(() => null);
    return { response, payload };
  };

  let { response, payload } = await send(accessToken);
  if (
    preferOauth &&
    response.status === 401 &&
    typeof options.onUnauthorizedOauth === "function"
  ) {
    const refreshed = await options.onUnauthorizedOauth();
    if (refreshed) {
      accessToken = refreshed;
      ({ response, payload } = await send(accessToken));
    }
  }

  if (!response.ok || payload?.error) {
    throw new CliError(
      payload?.error?.message ?? `MCP returned HTTP ${response.status}`,
      response.status === 401 ? 3 : 1,
      response.status,
      payload?.error?.code,
    );
  }
  return payload;
}
