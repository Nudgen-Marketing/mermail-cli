import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliError } from "../src/client.js";
import { printError, printOutput, sanitizeTerminalText } from "../src/output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("safe output", () => {
  it("removes terminal controls and bidirectional overrides from human output", async () => {
    expect(sanitizeTerminalText("\u001b]2;owned\u0007safe\u202etext")).toBe(" ]2;owned safetext");
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await printOutput([{ subject: "\u001b[31mVerify\u001b[0m\rspoof" }], "table");
    const rendered = stdout.mock.calls.flat().join("");
    expect(rendered).not.toContain("\u001b[31mVerify");
    expect(rendered).not.toContain("\u001b]2;");
    expect(rendered).not.toContain("\r");
    expect(rendered).toContain("[31mVerify");

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    printError(new CliError("\u001b]2;owned\u0007failed", 1, 400, "\u001b[31mbad"), "pretty");
    const renderedError = stderr.mock.calls.flat().join("");
    expect(renderedError).not.toContain("\u001b");
    expect(renderedError).toContain("[31mbad");
  });

  it("writes structured and binary output files with mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mermail-cli-output-"));
    temporaryDirectories.push(directory);
    const jsonPath = join(directory, "message.json");
    const binaryPath = join(directory, "attachment.bin");

    await writeFile(jsonPath, "old");
    await chmod(jsonPath, 0o644);
    await printOutput({ body: "private" }, "json", jsonPath);
    await printOutput(new Uint8Array([1, 2, 3]), "raw", binaryPath);

    expect((await stat(jsonPath)).mode & 0o777).toBe(0o600);
    expect((await stat(binaryPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(jsonPath, "utf8")).toContain("private");
    expect([...await readFile(binaryPath)]).toEqual([1, 2, 3]);
  });
});
