import { CliError, mcpRequest, type ClientOptions } from "./client.js";
import {
  loadOauthSession,
  refreshOauthSession,
  requireOauthSession,
  sessionHasScopes,
  type StoredOauthSession,
} from "./oauth.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function initialize(id: number, version: string) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "mermail-cli", version },
    },
  };
}

async function withOauthMcp(
  client: ClientOptions,
  session: StoredOauthSession,
  body: unknown,
) {
  let current = session;
  return mcpRequest(client, body, {
    auth: "oauth",
    accessToken: current.accessToken,
    onUnauthorizedOauth: async () => {
      const stored = (await loadOauthSession(client.baseUrl)) ?? current;
      current = await refreshOauthSession(client, stored);
      return current.accessToken;
    },
  });
}

export function extractMcpToolResult(payload: unknown): unknown {
  if (!isRecord(payload) || !isRecord(payload.result)) {
    throw new CliError("MCP tool call returned an invalid response", 1, 502, "mcp_invalid_response");
  }
  const result = payload.result;
  if (result.isError) {
    const structured = result.structuredContent;
    const message =
      (isRecord(structured) && typeof structured.error === "string" && structured.error) ||
      (isRecord(structured) && typeof structured.message === "string" && structured.message) ||
      "MCP tool call failed";
    const code =
      isRecord(structured) && typeof structured.code === "string"
        ? structured.code
        : typeof message === "string"
          ? message
          : "mcp_tool_error";
    throw new CliError(message, 1, 400, code, structured);
  }
  if ("structuredContent" in result && result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const content = result.content;
  if (Array.isArray(content)) {
    for (const entry of content) {
      if (!isRecord(entry)) continue;
      if (entry.type === "text" && typeof entry.text === "string") {
        try {
          return JSON.parse(entry.text);
        } catch {
          return entry.text;
        }
      }
    }
  }
  return result;
}

export async function callWalletTool(input: {
  client: ClientOptions;
  cliVersion: string;
  toolName: string;
  arguments: Record<string, unknown>;
  requiredScopes: string[];
}) {
  const session = await requireOauthSession(input.client);
  const missing = sessionHasScopes(session, input.requiredScopes);
  if (missing.length) {
    throw new CliError(
      `MCP OAuth session is missing scopes: ${missing.join(", ")}. Re-run \`mermail auth login\`.`,
      3,
      403,
      "wallet_scope_missing",
      { missing, granted: session.scopes },
    );
  }

  await withOauthMcp(input.client, session, initialize(1, input.cliVersion));
  const listed = await withOauthMcp(input.client, session, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  const tools = listed.result?.tools;
  if (!Array.isArray(tools)) {
    throw new CliError("MCP tools/list returned an invalid response", 1, 502, "mcp_invalid_response");
  }
  const names = new Set(
    tools
      .map((tool: { name?: unknown }) => (typeof tool?.name === "string" ? tool.name : null))
      .filter(Boolean),
  );
  if (!names.has(input.toolName)) {
    let connection: unknown;
    if (input.toolName === "get_paybox_connection") {
      const called = await withOauthMcp(input.client, session, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: input.toolName, arguments: input.arguments },
      });
      return extractMcpToolResult(called);
    }
    if (input.toolName.startsWith("paybox_")) {
      const probed = await withOauthMcp(input.client, session, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_paybox_connection", arguments: {} },
      });
      connection = extractMcpToolResult(probed);
      const refreshed = await withOauthMcp(input.client, session, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/list",
        params: {},
      });
      const refreshedTools = refreshed.result?.tools;
      if (Array.isArray(refreshedTools)) {
        for (const tool of refreshedTools) {
          if (typeof tool?.name === "string") names.add(tool.name);
        }
      }
    }
    if (names.has(input.toolName)) {
      const called = await withOauthMcp(input.client, session, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: input.toolName, arguments: input.arguments },
      });
      return extractMcpToolResult(called);
    }
    throw new CliError(
      `MCP tool ${input.toolName} is unavailable. Confirm the OAuth session has mcp:tools, the caller is the workspace owner, and PayBox Agent Wallet is connected in the Mermail console.`,
      1,
      403,
      "wallet_tool_unavailable",
      {
        tool: input.toolName,
        available: [...names].filter(
          (name): name is string =>
            typeof name === "string" &&
            (name.includes("wallet") || name.startsWith("paybox_")),
        ),
        ...(connection === undefined ? {} : { connection }),
      },
    );
  }

  const called = await withOauthMcp(input.client, session, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: input.toolName, arguments: input.arguments },
  });
  return extractMcpToolResult(called);
}

export type PayboxCredential = {
  id: string;
  kind: string;
  chains: string[];
  approvalMode: string;
  status: string;
};

export function parsePayboxCredentials(value: unknown): PayboxCredential[] {
  const root = isRecord(value) ? value : undefined;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(root?.credentials)
      ? root.credentials
      : Array.isArray(root?.granted)
        ? root.granted
        : Array.isArray(root?.items)
          ? root.items
          : [];
  return candidates.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    const metadata = isRecord(candidate.metadata) ? candidate.metadata : undefined;
    const policy = isRecord(candidate.access_policy)
      ? candidate.access_policy
      : isRecord(candidate.policy)
        ? candidate.policy
        : undefined;
    const id = typeof candidate.credential_id === "string"
      ? candidate.credential_id
      : typeof candidate.id === "string"
        ? candidate.id
        : "";
    const kind = typeof candidate.kind === "string"
      ? candidate.kind
      : typeof candidate.type === "string"
        ? candidate.type
        : "unknown";
    if (!id || !["wallet", "solana_wallet", "evm_wallet"].includes(kind.toLowerCase())) return [];
    const rawChains = metadata?.chains ?? candidate.chains ?? candidate.chain ?? candidate.caip2;
    const chains = Array.isArray(rawChains)
      ? rawChains.filter((entry): entry is string => typeof entry === "string")
      : typeof rawChains === "string"
        ? [rawChains]
        : [];
    return [{
      id,
      kind,
      chains: [...new Set(chains)],
      approvalMode: typeof candidate.approval_mode === "string"
        ? candidate.approval_mode
        : typeof policy?.approval_mode === "string"
          ? policy.approval_mode
          : "unknown",
      status: typeof candidate.status === "string" ? candidate.status : "ACTIVE",
    }];
  });
}

function isEvmChain(chain: string) {
  const normalized = chain.toLowerCase();
  return normalized === "evm" || normalized === "base" || normalized.startsWith("eip155:");
}

function credentialMatchesChain(credential: PayboxCredential, chain: string) {
  if (!["active", "connected"].includes(credential.status.toLowerCase())) return false;
  const requested = chain.toLowerCase();
  return credential.chains.some((value) => {
    const candidate = value.toLowerCase();
    return candidate === requested || (candidate === "evm" && isEvmChain(requested));
  });
}

export function selectPayboxCredential(
  value: unknown,
  chain: string,
  credentialId?: string,
) {
  const credentials = parsePayboxCredentials(value);
  const eligible = credentials.filter((credential) =>
    credentialMatchesChain(credential, chain) &&
    (credentialId === undefined || credential.id === credentialId));
  if (credentialId !== undefined) {
    const selected = eligible[0];
    if (!selected) {
      throw new CliError(
        `Selected credential ${credentialId} is not active or compatible with ${chain}`,
        2,
        409,
        "wallet_paybox_credential_unavailable",
        { credential_id: credentialId, chain },
      );
    }
    return selected;
  }
  const autonomous = eligible.filter((credential) => credential.approvalMode === "autonomous");
  const candidates = autonomous.length ? autonomous : eligible;
  if (candidates.length > 1) {
    throw new CliError(
      "Multiple eligible Agent Wallet credentials are available; pass --credential-id",
      2,
      409,
      "wallet_paybox_credential_ambiguous",
      { chain, credential_ids: candidates.map((credential) => credential.id) },
    );
  }
  if (!candidates[0]) {
    throw new CliError(
      `No active Agent Wallet credential is compatible with ${chain}`,
      2,
      409,
      "wallet_paybox_credential_unavailable",
      { chain },
    );
  }
  return candidates[0];
}

const SUCCESS_STATUSES = new Set(["success", "succeeded", "completed", "confirmed"]);
const FAILURE_STATUSES = new Set(["failure", "failed", "denied", "cancelled", "canceled", "rejected"]);
const INCOMPLETE_STATUSES = new Set([
  "setup_required",
  "pending_execution",
  "recovery_required",
  "pending_approval",
  "pending_signature",
  "pending",
  "in_progress",
  "queued",
  "submission_unknown",
]);

export function classifyPayboxResult(value: unknown) {
  const result = isRecord(value) ? value : { result: value };
  const rawStatus = typeof result.status === "string"
    ? result.status
    : typeof result.request_status === "string"
      ? result.request_status
      : undefined;
  const status = rawStatus?.toLowerCase();
  if (status && SUCCESS_STATUSES.has(status)) return { ...result, completed: true, terminal: true };
  if (status && FAILURE_STATUSES.has(status)) return { ...result, completed: false, terminal: true };
  if (!status && result.completed === true) return { ...result, completed: true, terminal: true };
  if (status && INCOMPLETE_STATUSES.has(status)) {
    return {
      ...result,
      completed: false,
      terminal: false,
      note: "Preserve this request_id and handoff. Check the original request; never resubmit the financial write automatically.",
    };
  }
  return {
    ...result,
    completed: false,
    terminal: false,
    note: "The Agent Wallet result is not an explicit terminal success. Preserve the original invocation and do not resubmit automatically.",
  };
}

export async function submitWalletTransfer(input: {
  client: ClientOptions;
  cliVersion: string;
  proposalId: string;
  version: number;
}) {
  const result = await callWalletTool({
    client: input.client,
    cliVersion: input.cliVersion,
    toolName: "submit_agent_wallet_transfer",
    requiredScopes: ["mcp:tools"],
    arguments: {
      proposalId: input.proposalId,
      version: input.version,
    },
  });

  const normalized = isRecord(result) && typeof result.status !== "string" && typeof result.proposal_status === "string"
    ? { ...result, status: result.proposal_status }
    : result;
  return classifyPayboxResult(normalized);
}
