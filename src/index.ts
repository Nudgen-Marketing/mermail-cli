#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { confirm } from "@inquirer/prompts";
import { Command, Option } from "commander";
import { apiRequest, CliError, mcpRequest, resolveClientOptions } from "./client.js";
import { operations, type Operation } from "./operations.js";
import { printError, printOutput, type OutputFormat } from "./output.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const program = new Command()
  .name("mermail")
  .description("Official CLI for Mermail Sold API, MCP, and agent workflows")
  .version(packageJson.version)
  .option("--api-key <key>", "Mermail API key (prefer MERMAIL_API_KEY)")
  .option("--base-url <url>", "API base URL", process.env.MERMAIL_BASE_URL)
  .addOption(new Option("--format <format>", "output format").choices(["json", "yaml", "pretty", "table", "raw"]).default(process.env.MERMAIL_FORMAT || "json"))
  .option("--timeout <ms>", "request timeout in milliseconds", "30000")
  .option("--debug", "print redacted request diagnostics");

const groups = new Map<string, Command>();
for (const operation of operations) {
  let group = groups.get(operation.group);
  if (!group) {
    group = program.command(operation.group).description(`${operation.group} operations`);
    groups.set(operation.group, group);
  }
  registerOperation(group, operation);
}

function registerOperation(group: Command, operation: Operation) {
  const command = group.command(operation.action).description(`${operation.method} ${operation.path}`);
  for (const param of operation.params ?? []) command.requiredOption(`--${kebab(param)} <value>`, `${param} path parameter`);
  command
    .option("--query <key=value>", "query parameter; repeatable", collect, [])
    .option("--data <json>", "JSON request body")
    .option("--data-file <path>", "JSON body file; use - for stdin")
    .option("--idempotency-key <key>", "credit-ledger idempotency key")
    .option("--output-file <path>", "write response to a file")
    .option("--yes", "confirm destructive action for automation")
    .option("--email <email>").option("--name <name>").option("--to <email...>").option("--from <email>")
    .option("--subject <subject>").option("--text <text>").option("--html <html>").option("--permanent")
    .action(async (local: Record<string, any>, current: Command) => runOperation(operation, local, current.optsWithGlobals()));
}

program.command("doctor").description("Check runtime, configuration, and public discovery without spending API credits").action(async (_local: unknown, current: Command) => {
  const client = resolveClientOptions(current.optsWithGlobals());
  const response = await fetch(`${client.baseUrl}/.well-known/mcp/server-card.json`, { signal: AbortSignal.timeout(client.timeout) });
  await printOutput({ node: process.version, baseUrl: client.baseUrl, apiKey: client.apiKey ? "configured" : "missing", discovery: response.ok ? "ok" : `HTTP ${response.status}`, telemetry: "disabled" }, outputFormat(current));
});

const auth = program.command("auth");
auth.command("check").description("Validate the API key (consumes one read credit)").action(async (_local: unknown, current: Command) => {
  const client = resolveClientOptions(current.optsWithGlobals());
  const { data } = await apiRequest(client, { method: "GET", path: "/api/v1/workspaces" });
  await printOutput({ authenticated: true, workspaces: data }, outputFormat(current));
});

const mcp = program.command("mcp");
mcp.command("check").description("Initialize MCP and require exactly 63 tools").action(async (_local: unknown, current: Command) => {
  const client = resolveClientOptions(current.optsWithGlobals());
  const init = await mcpRequest(client, initialize(1));
  const listed = await mcpRequest(client, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const count = listed.result?.tools?.length ?? 0;
  if (count !== 63) throw new CliError(`Expected 63 MCP tools, discovered ${count}`);
  await printOutput({ connected: true, server: init.result.serverInfo, tools: count }, outputFormat(current));
});
mcp.command("tools").description("List MCP tools").action(async (_local: unknown, current: Command) => {
  const client = resolveClientOptions(current.optsWithGlobals());
  const listed = await mcpRequest(client, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  await printOutput(listed.result.tools, outputFormat(current));
});

program.command("completion <shell>").description("Print shell completion for bash, zsh, or fish").action((shell) => {
  if (!["bash", "zsh", "fish"].includes(shell)) throw new CliError("Shell must be bash, zsh, or fish", 2);
  process.stdout.write(completionScript(shell));
});

async function runOperation(operation: Operation, local: Record<string, any>, globals: Record<string, any>) {
  if (operation.destructive && !local.yes) {
    if (!process.stdin.isTTY) throw new CliError("Destructive commands require --yes in non-interactive mode", 4);
    const accepted = await confirm({ message: `Run ${operation.tool} on ${operation.params?.map((p) => `${p}=${local[p]}`).join(", ") || "the selected resource"}?` });
    if (!accepted) throw new CliError("Cancelled", 130);
  }
  const client = resolveClientOptions(globals);
  let path = operation.path;
  for (const param of operation.params ?? []) path = path.replace(`{${param}}`, encodeURIComponent(String(local[param])));
  const query = Object.fromEntries((local.query as string[]).map(parsePair));
  if (local.permanent) query.permanent = "true";
  const body = await bodyFrom(local, operation.method);
  const { data } = await apiRequest(client, { method: operation.method, path, query, body, idempotencyKey: local.idempotencyKey });
  await printOutput(data, globals.format, local.outputFile);
}

async function bodyFrom(options: Record<string, any>, method: string) {
  if (["GET", "DELETE"].includes(method)) return undefined;
  if (options.data && options.dataFile) throw new CliError("Use only one of --data or --data-file", 2);
  let body: Record<string, unknown> = {};
  if (options.data) body = parseJson(options.data);
  if (options.dataFile) body = parseJson(options.dataFile === "-" ? await readStdin() : await readFile(options.dataFile, "utf8"));
  for (const key of ["email", "name", "from", "subject", "text", "html"] as const) if (options[key] !== undefined) body[key] = options[key];
  if (options.to !== undefined) body.to = options.to.length === 1 ? options.to[0] : options.to;
  return body;
}

function parseJson(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(); return parsed; }
  catch { throw new CliError("Request body must be a JSON object", 2); }
}
function collect(value: string, previous: string[]) { return [...previous, value]; }
function parsePair(value: string): [string, string] { const index = value.indexOf("="); if (index < 1) throw new CliError(`Expected key=value, received ${value}`, 2); return [value.slice(0, index), value.slice(index + 1)]; }
function kebab(value: string) { return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function outputFormat(command: Command): OutputFormat { return command.optsWithGlobals().format; }
function initialize(id: number) { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mermail-cli", version: packageJson.version } } }; }
async function readStdin() { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
function completionScript(shell: string) {
  const groups = [...new Set(operations.map((operation) => operation.group))];
  const root = [...groups, "doctor", "auth", "mcp", "completion", "help"].join(" ");
  if (shell === "fish") return `complete -c mermail -f\ncomplete -c mermail -n '__fish_use_subcommand' -a '${root}'\n`;
  if (shell === "zsh") return `#compdef mermail\n_arguments '1:command:(${root})' '*::arg:->args'\n`;
  return `_mermail() { local cur; cur="\${COMP_WORDS[COMP_CWORD]}"; COMPREPLY=( $(compgen -W '${root}' -- "$cur") ); }\ncomplete -F _mermail mermail\n`;
}

program.exitOverride();
program.parseAsync().catch((error) => {
  if (error?.code === "commander.helpDisplayed" || error?.code === "commander.version") return;
  const format = (program.opts().format || "json") as OutputFormat;
  printError(error, format);
  process.exitCode = error instanceof CliError ? error.exitCode : error?.code?.startsWith?.("commander.") ? 2 : 1;
});

export { program };
