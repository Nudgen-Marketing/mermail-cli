import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CliError, type ClientOptions } from "./client.js";

export const DEFAULT_WALLET_SCOPES = [
  "mcp:tools",
  "openid",
  "offline_access",
  "wallet:read",
  "wallet:transact",
] as const;

export const WALLET_READ_SCOPES = [
  "mcp:tools",
  "openid",
  "offline_access",
  "wallet:read",
] as const;

export type StoredOauthSession = {
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  resource: string;
  updatedAt: string;
};

type AuthorizationServerMetadata = {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint?: string;
};

function configDir() {
  if (process.env.MERMAIL_CONFIG_DIR?.trim()) {
    return process.env.MERMAIL_CONFIG_DIR.trim();
  }
  if (process.env.XDG_CONFIG_HOME?.trim()) {
    return join(process.env.XDG_CONFIG_HOME.trim(), "mermail");
  }
  return join(homedir(), ".config", "mermail");
}

export function oauthSessionPath() {
  return join(configDir(), "mcp-oauth.json");
}

export function normalizeBaseUrl(value: string) {
  return value.replace(/\/+$/, "");
}

export async function loadOauthSession(
  baseUrl?: string,
): Promise<StoredOauthSession | null> {
  try {
    const raw = await readFile(oauthSessionPath(), "utf8");
    const parsed = JSON.parse(raw) as StoredOauthSession;
    if (
      !parsed ||
      typeof parsed.accessToken !== "string" ||
      typeof parsed.refreshToken !== "string" ||
      typeof parsed.clientId !== "string" ||
      typeof parsed.baseUrl !== "string" ||
      !Array.isArray(parsed.scopes)
    ) {
      return null;
    }
    if (baseUrl && normalizeBaseUrl(parsed.baseUrl) !== normalizeBaseUrl(baseUrl)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveOauthSession(session: StoredOauthSession) {
  const dir = configDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = oauthSessionPath();
  await writeFile(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // Best-effort on platforms that ignore mode.
  }
}

export async function clearOauthSession() {
  try {
    await unlink(oauthSessionPath());
  } catch {
    // Already gone.
  }
}

function base64Url(buffer: Buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createPkcePair() {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

async function discoverAuthorizationServer(
  baseUrl: string,
  timeout: number,
): Promise<AuthorizationServerMetadata> {
  const origin = normalizeBaseUrl(baseUrl);
  const response = await fetch(`${origin}/.well-known/oauth-authorization-server`, {
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    throw new CliError(
      `OAuth discovery failed with HTTP ${response.status}`,
      1,
      response.status,
      "oauth_discovery_failed",
    );
  }
  const body = (await response.json()) as AuthorizationServerMetadata;
  for (const key of [
    "authorization_endpoint",
    "token_endpoint",
    "registration_endpoint",
  ] as const) {
    if (typeof body[key] !== "string" || !body[key]) {
      throw new CliError(
        `OAuth discovery missing ${key}`,
        1,
        502,
        "oauth_discovery_invalid",
      );
    }
  }
  return body;
}

async function registerPublicClient(input: {
  registrationEndpoint: string;
  redirectUri: string;
  scopes: string[];
  timeout: number;
}) {
  const response = await fetch(input.registrationEndpoint, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Mermail CLI",
      redirect_uris: [input.redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: input.scopes.join(" "),
    }),
    signal: AbortSignal.timeout(input.timeout),
  });
  const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof body?.client_id !== "string") {
    throw new CliError(
      typeof body?.error_description === "string"
        ? body.error_description
        : typeof body?.error === "string"
          ? body.error
          : `OAuth client registration failed with HTTP ${response.status}`,
      1,
      response.status,
      typeof body?.error === "string" ? body.error : "oauth_registration_failed",
    );
  }
  return body.client_id;
}

async function startLoopbackCallback(input: {
  expectedState: string;
  timeoutMs: number;
}) {
  return await new Promise<{
    redirectUri: string;
    codePromise: Promise<{ code: string; redirectUri: string; close: () => Promise<void> }>;
  }>((resolveListen, rejectListen) => {
    let settled = false;
    let listening = false;
    let codeResolve!: (code: string) => void;
    let codeReject!: (error: unknown) => void;
    const codePromise = new Promise<string>((res, rej) => {
      codeResolve = res;
      codeReject = rej;
    });

    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.writeHead(404).end("Not found");
          return;
        }
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
          fail(
            new CliError(
              url.searchParams.get("error_description") ?? `OAuth authorization failed: ${error}`,
              1,
              401,
              "oauth_denied",
            ),
          );
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        if (!code || state !== input.expectedState) {
          res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
          res.end("<html><body><h1>Invalid OAuth callback</h1></body></html>");
          fail(new CliError("Invalid OAuth callback state or code", 1, 400, "oauth_invalid_callback"));
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(
          "<html><body><h1>Mermail CLI authorized</h1><p>You can close this tab and return to the terminal.</p></body></html>",
        );
        succeed(code);
      } catch (error) {
        fail(error);
      }
    });

    const timer = setTimeout(() => {
      fail(new CliError("Timed out waiting for OAuth browser consent", 1, 408, "oauth_timeout"));
    }, input.timeoutMs);

    function succeed(code: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      codeResolve(code);
    }

    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const err = error instanceof Error ? error : new Error(String(error));
      server.close(() => {
        codeReject(err);
        if (!listening) rejectListen(err);
      });
    }

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        fail(new CliError("Unable to bind OAuth loopback server", 1, 500, "oauth_loopback_failed"));
        return;
      }
      listening = true;
      const redirectUri = `http://127.0.0.1:${address.port}/callback`;
      resolveListen({
        redirectUri,
        codePromise: codePromise.then((code) => ({
          code,
          redirectUri,
          close: () =>
            new Promise<void>((closeResolve, closeReject) => {
              server.close((closeError) => (closeError ? closeReject(closeError) : closeResolve()));
            }),
        })),
      });
    });
    server.on("error", fail);
  });
}

function openBrowser(url: string) {
  const platform = process.platform;
  try {
    if (platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else if (platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // User can open the printed URL manually.
  }
}

async function exchangeToken(input: {
  tokenEndpoint: string;
  body: URLSearchParams;
  timeout: number;
}) {
  const response = await fetch(input.tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: input.body,
    signal: AbortSignal.timeout(input.timeout),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (
    !response.ok ||
    typeof payload?.access_token !== "string" ||
    typeof payload.refresh_token !== "string"
  ) {
    throw new CliError(
      typeof payload?.error_description === "string"
        ? payload.error_description
        : typeof payload?.error === "string"
          ? payload.error
          : `OAuth token exchange failed with HTTP ${response.status}`,
      response.status === 401 ? 3 : 1,
      response.status,
      typeof payload?.error === "string" ? payload.error : "oauth_token_failed",
    );
  }
  const expiresIn =
    typeof payload.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;
  const scope =
    typeof payload.scope === "string"
      ? payload.scope.split(/\s+/).filter(Boolean)
      : [];
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + expiresIn * 1000,
    scopes: scope,
  };
}

export function parseScopes(value: unknown, wallet = false): string[] {
  if (typeof value === "string" && value.trim()) {
    return [...new Set(value.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean))];
  }
  return [...(wallet ? DEFAULT_WALLET_SCOPES : WALLET_READ_SCOPES)];
}

export async function loginWithOauth(input: {
  client: ClientOptions;
  scopes: string[];
  openBrowser?: boolean;
  loginTimeoutMs?: number;
}): Promise<StoredOauthSession> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError(
      "Interactive OAuth login requires a TTY. Run `mermail auth login` from a terminal, or skip wallet automation in CI.",
      1,
      undefined,
      "oauth_requires_tty",
    );
  }
  const baseUrl = normalizeBaseUrl(input.client.baseUrl);
  const metadata = await discoverAuthorizationServer(baseUrl, input.client.timeout);
  const state = base64Url(randomBytes(16));
  const pkce = createPkcePair();
  const loopback = await startLoopbackCallback({
    expectedState: state,
    timeoutMs: input.loginTimeoutMs ?? 5 * 60_000,
  });
  const clientId = await registerPublicClient({
    registrationEndpoint: metadata.registration_endpoint,
    redirectUri: loopback.redirectUri,
    scopes: input.scopes,
    timeout: input.client.timeout,
  });
  const resource = `${baseUrl}/mcp`;
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", loopback.redirectUri);
  authorize.searchParams.set("scope", input.scopes.join(" "));
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", pkce.challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("resource", resource);

  process.stderr.write(`Open this URL to authorize Mermail CLI:\n${authorize.toString()}\n`);
  if (input.openBrowser !== false) openBrowser(authorize.toString());

  const callback = await loopback.codePromise;
  try {
    const token = await exchangeToken({
      tokenEndpoint: metadata.token_endpoint,
      timeout: input.client.timeout,
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: callback.code,
        redirect_uri: callback.redirectUri,
        client_id: clientId,
        code_verifier: pkce.verifier,
        resource,
      }),
    });
    const session: StoredOauthSession = {
      baseUrl,
      clientId,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresAt: token.expiresAt,
      scopes: token.scopes.length ? token.scopes : input.scopes,
      resource,
      updatedAt: new Date().toISOString(),
    };
    await saveOauthSession(session);
    return session;
  } finally {
    await callback.close().catch(() => undefined);
  }
}

export async function refreshOauthSession(
  client: ClientOptions,
  session: StoredOauthSession,
): Promise<StoredOauthSession> {
  const metadata = await discoverAuthorizationServer(session.baseUrl, client.timeout);
  const token = await exchangeToken({
    tokenEndpoint: metadata.token_endpoint,
    timeout: client.timeout,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
      resource: session.resource,
    }),
  });
  const next: StoredOauthSession = {
    ...session,
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    scopes: token.scopes.length ? token.scopes : session.scopes,
    updatedAt: new Date().toISOString(),
  };
  await saveOauthSession(next);
  return next;
}

export async function logoutOauth(client: ClientOptions) {
  const session = await loadOauthSession(client.baseUrl);
  if (!session) {
    await clearOauthSession();
    return { revoked: false, cleared: true };
  }
  let revoked = false;
  try {
    const metadata = await discoverAuthorizationServer(session.baseUrl, client.timeout);
    if (metadata.revocation_endpoint) {
      const response = await fetch(metadata.revocation_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: session.refreshToken,
          token_type_hint: "refresh_token",
          client_id: session.clientId,
        }),
        signal: AbortSignal.timeout(client.timeout),
      });
      revoked = response.ok;
    }
  } catch {
    // Still clear local credentials.
  }
  await clearOauthSession();
  return { revoked, cleared: true };
}

export async function requireOauthSession(client: ClientOptions): Promise<StoredOauthSession> {
  const session = await loadOauthSession(client.baseUrl);
  if (!session) {
    throw new CliError(
      "MCP OAuth login required. Run `mermail auth login --wallet`.",
      3,
      401,
      "oauth_required",
    );
  }
  if (session.expiresAt > Date.now() + 30_000) return session;
  try {
    return await refreshOauthSession(client, session);
  } catch (error) {
    await clearOauthSession();
    throw new CliError(
      "MCP OAuth session expired. Run `mermail auth login --wallet` again.",
      3,
      401,
      "oauth_relogin_required",
      error instanceof CliError ? { cause: error.code } : undefined,
    );
  }
}

export function sessionHasScopes(session: StoredOauthSession, required: string[]) {
  const granted = new Set(session.scopes);
  return required.filter((scope) => !granted.has(scope));
}

export function redactOauthSession(session: StoredOauthSession) {
  return {
    baseUrl: session.baseUrl,
    clientId: session.clientId,
    scopes: session.scopes,
    resource: session.resource,
    expiresAt: new Date(session.expiresAt).toISOString(),
    updatedAt: session.updatedAt,
    hasAccessToken: Boolean(session.accessToken),
    hasRefreshToken: Boolean(session.refreshToken),
  };
}
