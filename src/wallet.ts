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

  if (isRecord(result)) {
    const status =
      typeof result.status === "string"
        ? result.status
        : typeof result.proposal_status === "string"
          ? result.proposal_status
          : undefined;
    const hasSigningHandoff = isRecord(result.signing_handoff);
    if (
      result.completed === false ||
      hasSigningHandoff ||
      (status && /pending|unknown|submission_unknown|pending_paybox_approval/i.test(status))
    ) {
      return {
        ...result,
        completed: false,
        note: "Pending or unknown submission is not success. Do not retry automatically; finish any PayBox approval in the console if required.",
      };
    }
  }
  return { ...(isRecord(result) ? result : { result }), completed: true };
}
