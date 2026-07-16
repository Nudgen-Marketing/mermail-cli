import Table from "cli-table3";
import YAML from "yaml";
import { writeFile } from "node:fs/promises";
import { CliError } from "./client.js";

export type OutputFormat = "json" | "yaml" | "pretty" | "table" | "raw";

export async function printOutput(value: unknown, format: OutputFormat, outputFile?: string) {
  if (value instanceof Uint8Array) {
    if (outputFile) return void await writeFile(outputFile, value);
    if (process.stdout.isTTY && format !== "raw") throw new CliError("Binary output requires --output-file or --format raw", 2);
    return void process.stdout.write(value);
  }
  if (outputFile) return void await writeFile(outputFile, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (format === "yaml") return void process.stdout.write(YAML.stringify(value));
  if (format === "table" || format === "pretty") {
    const rows = Array.isArray(value) ? value : [value];
    if (rows.length && rows.every((item) => item && typeof item === "object" && !Array.isArray(item))) {
      const keys = [...new Set(rows.flatMap((item) => Object.keys(item as object)))];
      const table = new Table({ head: keys });
      for (const row of rows) table.push(keys.map((key) => display((row as Record<string, unknown>)[key])));
      return void process.stdout.write(`${table.toString()}\n`);
    }
  }
  if (format === "raw" && typeof value === "string") return void process.stdout.write(value);
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function display(value: unknown) {
  if (value == null) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function printError(error: unknown, format: OutputFormat) {
  const normalized = error instanceof CliError
    ? { status: error.status, code: error.code, message: error.message, details: error.details }
    : { message: error instanceof Error ? error.message : String(error) };
  if (format === "json") process.stderr.write(`${JSON.stringify({ error: normalized })}\n`);
  else process.stderr.write(`Error${normalized.code ? ` [${normalized.code}]` : ""}: ${normalized.message}\n`);
}
