import { setTimeout as delay } from "node:timers/promises";

export class CliError extends Error {
  constructor(message: string, public readonly exitCode = 1, public readonly status?: number, public readonly code?: string, public readonly details?: unknown) {
    super(message);
  }
}

export type ClientOptions = { apiKey?: string; baseUrl: string; timeout: number; debug?: boolean };

export function resolveClientOptions(options: Record<string, unknown>): ClientOptions {
  const apiKey = String(options.apiKey || process.env.MERMAIL_API_KEY || "").trim() || undefined;
  const baseUrl = String(options.baseUrl || process.env.MERMAIL_BASE_URL || "https://console.mermail.app").replace(/\/+$/, "");
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) throw new CliError("Base URL must use HTTPS except for localhost", 2);
  return { apiKey, baseUrl, timeout: Number(options.timeout || 30_000), debug: Boolean(options.debug) };
}

export async function apiRequest(client: ClientOptions, input: { method: string; path: string; query?: Record<string, string>; body?: unknown; idempotencyKey?: string }): Promise<{ data: unknown; response: Response }> {
  if (!client.apiKey) throw new CliError("MERMAIL_API_KEY is not set. Export it or pass --api-key.", 3, 401, "api_key_required");
  const url = new URL(input.path, client.baseUrl);
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.append(key, value);
  const headers: Record<string, string> = { accept: "application/json", "x-api-key": client.apiKey };
  if (input.body !== undefined) headers["content-type"] = "application/json";
  if (input.idempotencyKey) headers["idempotency-key"] = input.idempotencyKey;
  const attempts = input.method === "GET" ? 3 : 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      if (client.debug) process.stderr.write(`[debug] ${input.method} ${url.toString()}\n`);
      const response = await fetch(url, { method: input.method, headers, body: input.body === undefined ? undefined : JSON.stringify(input.body), signal: AbortSignal.timeout(client.timeout) });
      if ([408, 429, 502, 503, 504].includes(response.status) && attempt + 1 < attempts) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await delay(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt + Math.random() * 100);
        continue;
      }
      const type = response.headers.get("content-type") ?? "";
      const data = response.status === 204 ? { ok: true, status: 204 } : type.includes("json") ? await response.json() : new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        const body = data as { error?: string; code?: string; message?: string; details?: unknown };
        const code = body.code ?? body.error;
        throw new CliError(body.message ?? body.error ?? `HTTP ${response.status}`, response.status === 401 ? 3 : 1, response.status, code, body.details);
      }
      return { data, response };
    } catch (error) {
      lastError = error;
      if (error instanceof CliError || attempt + 1 >= attempts) throw error;
      await delay(250 * 2 ** attempt + Math.random() * 100);
    }
  }
  throw lastError;
}

export async function mcpRequest(client: ClientOptions, body: unknown): Promise<any> {
  if (!client.apiKey) throw new CliError("MERMAIL_API_KEY is not set. Export it or pass --api-key.", 3);
  const response = await fetch(`${client.baseUrl}/mcp`, {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json", "x-api-key": client.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(client.timeout)
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.error) throw new CliError(payload?.error?.message ?? `MCP returned HTTP ${response.status}`, response.status === 401 ? 3 : 1, response.status, payload?.error?.code);
  return payload;
}
