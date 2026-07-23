import Table from "cli-table3";
import YAML from "yaml";
import { open } from "node:fs/promises";
import { CliError } from "./client.js";
import { select } from "@inquirer/prompts";

export type OutputFormat = "json" | "yaml" | "pretty" | "table" | "raw" | "explore";

export async function printOutput(value: unknown, format: OutputFormat, outputFile?: string) {
  if (value instanceof Uint8Array) {
    if (outputFile) return void await writePrivateFile(outputFile, value);
    if (process.stdout.isTTY && format !== "raw") throw new CliError("Binary output requires --output-file or --format raw", 2);
    return void process.stdout.write(value);
  }
  if (outputFile) return void await writePrivateFile(outputFile, `${JSON.stringify(value, null, 2)}\n`);
  if (format === "explore") return void await explore(value);
  if (format === "yaml") return void process.stdout.write(YAML.stringify(value));
  if (format === "table" || format === "pretty") {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length && rows.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const keys = [...new Set(rows.flatMap((item) => Object.keys(item as object)))];
      const table = new Table({ head: keys.map(sanitizeTerminalText) });
      for (const row of rows) table.push(keys.map((key) => display((row as Record<string, unknown>)[key])));
      return void process.stdout.write(`${table.toString()}\n`);
    }
  }
  if (format === "raw" && typeof value === "string") return void process.stdout.write(value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function explore(value: unknown) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new CliError("Explore format requires an interactive terminal", 2);
  let current = value;
  const trail: unknown[] = [];
  while (current && typeof current === "object") {
    const entries = Array.isArray(current) ? current.map((item, index) => [String(index), item] as const) : Object.entries(current);
    if (!entries.length) break;
    const choice = await select({ message: "Explore response", choices: [
      ...entries.map(([key, item]) => ({ name: `${sanitizeTerminalText(key)}: ${preview(item)}`, value: key })),
      ...(trail.length ? [{ name: "← back", value: "__back" }] : []),
      { name: "✓ print current value", value: "__print" }
    ] });
    if (choice === "__print") break;
    if (choice === "__back") { current = trail.pop(); continue; }
    trail.push(current);
    current = Array.isArray(current) ? current[Number(choice)] : (current as Record<string, unknown>)[choice];
  }
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
}

function preview(value: unknown) {
  const text = sanitizeTerminalText(typeof value === "object" ? JSON.stringify(value) : String(value));
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function display(value: unknown) {
  if (value == null) return "";
  return sanitizeTerminalText(typeof value === "object" ? JSON.stringify(value) : String(value));
}

async function writePrivateFile(path: string, value: string | Uint8Array) {
  const file = await open(path, "a", 0o600);
  try {
    await file.chmod(0o600);
    await file.truncate(0);
    await file.writeFile(value);
  } finally {
    await file.close();
  }
}

export function sanitizeTerminalText(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ")
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "");
}

export function printError(error: unknown, format: OutputFormat) {
  const normalized = error instanceof CliError
    ? { status: error.status, code: error.code, message: error.message, requestId: error.requestId, retryAfterMs: error.retryAfterMs, details: error.details }
    : { message: error instanceof Error ? error.message : String(error) };
  if (format === "json") process.stderr.write(`${JSON.stringify({ error: normalized })}\n`);
  else process.stderr.write(sanitizeTerminalText(`Error${normalized.code ? ` [${normalized.code}]` : ""}: ${normalized.message}`) + "\n");
}
