#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { confirm } from "@inquirer/prompts";
import { Command, Option } from "commander";
import jmespath from "jmespath";
import { apiRequest, CliError, mcpRequest, resolveClientOptions } from "./client.js";
import { operationSchemas } from "./generated-schema.js";
import { operations, type Operation } from "./operations.js";
import { printError, printOutput, type OutputFormat } from "./output.js";
import { DEFAULT_EMAIL_POLL_INTERVAL, DEFAULT_EMAIL_WAIT_TIMEOUT, waitForEmail } from "./workflows.js";

type GeneratedField = { readonly name: string; readonly type: string; readonly required: boolean; readonly description?: string; readonly values?: readonly unknown[] };
const schemas = operationSchemas as Record<string, { readonly query: readonly GeneratedField[]; readonly body: readonly GeneratedField[] }>;
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
const program = new Command()
  .name("mermail")
  .description("Official CLI for Mermail Sold API, MCP, and agent workflows")
  .version(packageJson.version)
  .option("--api-key <key>", "Mermail API key (prefer MERMAIL_API_KEY)")
  .option("--base-url <url>", "API base URL", process.env.MERMAIL_BASE_URL)
  .addOption(new Option("--format <format>", "output format").choices(["json", "yaml", "pretty", "table", "raw", "explore"]).default(process.env.MERMAIL_FORMAT || "json"))
  .option("--timeout <ms>", "request timeout in milliseconds", "30000")
  .option("--transform <expression>", "transform JSON output with JMESPath")
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

groups.get("emails")!
  .command("wait")
  .description("Wait for a matching email, then return its full body and metadata")
  .requiredOption("--mailbox-id <id>", "mailbox public_id, hosted alias id, or current email")
  .option("--query <text>", "match text across subject, body, sender, and recipients")
  .option("--from <sender>", "match sender address or name")
  .option("--subject <text>", "match subject text")
  .option("--folder <id>", "limit matches to a folder id, such as inbox")
  .option("--after <iso-date>", "only match email on or after this ISO date")
  .option("--wait-timeout <ms>", "total time to wait in milliseconds", String(DEFAULT_EMAIL_WAIT_TIMEOUT))
  .option("--poll-interval <ms>", "delay between searches in milliseconds", String(DEFAULT_EMAIL_POLL_INTERVAL))
  .option("--output-file <path>", "write the matching email to a file")
  .addHelpText("after", "\nAt least one semantic filter (--query, --from, or --subject) is required.\n--after and --folder may be added to narrow the match further.\n")
  .action(async (local: Record<string, any>, current: Command) => {
    const globals = current.optsWithGlobals();
    const client = resolveClientOptions(globals);
    const waitTimeout = integerOption(local.waitTimeout, "--wait-timeout", 100, 3_600_000);
    const pollInterval = integerOption(local.pollInterval, "--poll-interval", 250, 60_000);
    if (![local.query, local.from, local.subject].some((value) => typeof value === "string" && value.trim())) {
      throw new CliError("emails wait requires at least one semantic filter: --query, --from, or --subject", 2);
    }
    const after = local.after === undefined ? undefined : isoDate(local.after);
    const data = await waitForEmail(client, {
      mailboxId: local.mailboxId,
      query: local.query,
      from: local.from,
      subject: local.subject,
      folder: local.folder,
      after,
      waitTimeout,
      pollInterval,
    });
    const transformed = globals.transform ? transform(data, globals.transform) : data;
    await printOutput(transformed, globals.format, local.outputFile);
  });

function registerOperation(group: Command, operation: Operation) {
  const command = group.command(operation.action).description(`${operation.method} ${operation.path}`);
  const schema = schemas[operation.tool]!;
  const registered = new Set<string>();
  for (const param of operation.params ?? []) command.requiredOption(`--${kebab(param)} <value>`, `${param} path parameter`);
  for (const param of operation.params ?? []) registered.add(param);
  for (const field of schema.query) if (!registered.has(field.name)) {
    command.addOption(fieldOption(field, "query"));
    registered.add(field.name);
  }
  for (const field of schema.body) if (!registered.has(field.name)) {
    command.addOption(fieldOption(field, "body"));
    registered.add(field.name);
  }
  command.option("--query-param <key=value>", "additional query parameter; repeatable", collect, []);
  if (!["GET", "DELETE"].includes(operation.method)) command.option("--data <json>", "JSON request body").option("--data-file <path>", "JSON body file; use - for stdin").option("--idempotency-key <key>", "credit-ledger idempotency key");
  command.option("--output-file <path>", "write response to a file");
  if (operation.destructive) command.option("--yes", "confirm destructive action for automation");
  command.action(async (local: Record<string, any>, current: Command) => runOperation(operation, local, current.optsWithGlobals()));
}

program.command("doctor").description("Check runtime, configuration, and public discovery without spending API credits").action(async (_local: unknown, current: Command) => {
  const client = resolveClientOptions(current.optsWithGlobals());
  let discovery = "ok";
  try {
    const response = await fetch(`${client.baseUrl}/.well-known/mcp/server-card.json`, { signal: AbortSignal.timeout(client.timeout) });
    if (!response.ok) discovery = `HTTP ${response.status}`;
  } catch (error) {
    discovery = error instanceof Error ? error.message : "unreachable";
  }
  await printOutput({ node: process.version, baseUrl: client.baseUrl, apiKey: client.apiKey ? "configured" : "missing", discovery, telemetry: "disabled" }, outputFormat(current));
  if (discovery !== "ok") throw new CliError(`MCP discovery failed: ${discovery}`, 1);
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
  const query = Object.fromEntries((local.queryParam as string[]).map(parsePair));
  for (const field of schemas[operation.tool]!.query) if (local[field.name] !== undefined) query[field.name] = String(local[field.name]);
  const body = await bodyFrom(local, operation);
  const { data } = await apiRequest(client, { method: operation.method, path, query, body, idempotencyKey: local.idempotencyKey });
  const transformed = globals.transform ? transform(data, globals.transform) : data;
  await printOutput(transformed, globals.format, local.outputFile);
}

async function bodyFrom(options: Record<string, any>, operation: Operation) {
  if (["GET", "DELETE"].includes(operation.method)) return undefined;
  if (options.data && options.dataFile) throw new CliError("Use only one of --data or --data-file", 2);
  let body: Record<string, unknown> = {};
  if (options.data) body = parseJson(options.data);
  if (options.dataFile) body = parseJson(options.dataFile === "-" ? await readStdin() : await readFile(options.dataFile, "utf8"));
  for (const field of schemas[operation.tool]!.body) if (options[field.name] !== undefined) body[field.name] = coerce(options[field.name], field.type);
  const missing = schemas[operation.tool]!.body.filter((field) => field.required && body[field.name] === undefined).map((field) => field.name);
  if (missing.length) throw new CliError(`Missing required body fields: ${missing.join(", ")}`, 2);
  return body;
}

function parseJson(value: string): Record<string, unknown> {
  try { const parsed = JSON.parse(value); if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(); return parsed; }
  catch { throw new CliError("Request body must be a JSON object", 2); }
}
function collect(value: string, previous: string[]) { return [...previous, value]; }
function parsePair(value: string): [string, string] { const index = value.indexOf("="); if (index < 1) throw new CliError(`Expected key=value, received ${value}`, 2); return [value.slice(0, index), value.slice(index + 1)]; }
function kebab(value: string) { return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`); }
function integerOption(value: unknown, name: string, minimum: number, maximum: number) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new CliError(`${name} must be an integer between ${minimum} and ${maximum} milliseconds`, 2);
  return number;
}
function isoDate(value: unknown) {
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new CliError("--after must be a valid ISO date", 2);
  return date.toISOString();
}
function fieldOption(field: { name: string; type: string; required: boolean; description?: string; values?: readonly unknown[] }, location: string) {
  const flag = `--${kebab(field.name)}`;
  const syntax = field.type === "boolean" ? flag : `${flag} <value${field.type === "array" ? "..." : ""}>`;
  const option = new Option(syntax, field.description || `${field.name} ${location} field`);
  if (field.required && location === "query") option.makeOptionMandatory();
  if (field.values?.length) option.choices(field.values.map(String));
  return option;
}
function coerce(value: unknown, type: string): unknown {
  if (type === "number" || type === "integer") { const number = Number(value); if (!Number.isFinite(number)) throw new CliError(`Expected a number, received ${value}`, 2); return number; }
  if (type === "boolean") return Boolean(value);
  if (type === "array") return (Array.isArray(value) ? value : [value]).map((entry) => parseJsonValue(entry));
  if (type === "json") return parseJsonValue(value);
  return value;
}
function parseJsonValue(value: unknown) { if (typeof value !== "string") return value; try { return JSON.parse(value); } catch { return value; } }
function transform(value: unknown, expression: string) { try { return jmespath.search(value, expression); } catch (error) { throw new CliError(`Invalid JMESPath transform: ${error instanceof Error ? error.message : String(error)}`, 2); } }
function outputFormat(command: Command): OutputFormat { return command.optsWithGlobals().format; }
function initialize(id: number) { return { jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "mermail-cli", version: packageJson.version } } }; }
async function readStdin() { const chunks: Buffer[] = []; for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks).toString("utf8"); }
function completionScript(shell: string) {
  const groups = [...new Set(operations.map((operation) => operation.group))];
  const root = [...groups, "doctor", "auth", "mcp", "completion", "help"].join(" ");
  const extraActions: Record<string, string[]> = { emails: ["wait"] };
  const actions = Object.fromEntries(groups.map((group) => [group, [
    ...operations.filter((operation) => operation.group === group).map((operation) => operation.action),
    ...(extraActions[group] ?? []),
  ].join(" ")]));
  if (shell === "fish") return `complete -c mermail -f\ncomplete -c mermail -n '__fish_use_subcommand' -a '${root}'\n${Object.entries(actions).map(([group, values]) => `complete -c mermail -n '__fish_seen_subcommand_from ${group}' -a '${values}'`).join("\n")}\n`;
  if (shell === "zsh") return `#compdef mermail\nlocal -a commands\ncommands=(${root})\nif (( CURRENT == 2 )); then _describe command commands; return; fi\ncase $words[2] in\n${Object.entries(actions).map(([group, values]) => `  ${group}) _values action ${values} ;;`).join("\n")}\nesac\n`;
  const cases = Object.entries(actions).map(([group, values]) => `${group}) words='${values}' ;;`).join(" ");
  return `_mermail() { local cur words; cur="\${COMP_WORDS[COMP_CWORD]}"; if [[ $COMP_CWORD -eq 1 ]]; then words='${root}'; else case "\${COMP_WORDS[1]}" in ${cases} *) words='' ;; esac; fi; COMPREPLY=( $(compgen -W "$words" -- "$cur") ); }\ncomplete -F _mermail mermail\n`;
}

program.exitOverride();
program.parseAsync().catch((error) => {
  if (error?.code === "commander.helpDisplayed" || error?.code === "commander.version") return;
  const format = (program.opts().format || "json") as OutputFormat;
  printError(error, format);
  process.exitCode = error instanceof CliError ? error.exitCode : error?.code?.startsWith?.("commander.") ? 2 : 1;
});

export { program };
