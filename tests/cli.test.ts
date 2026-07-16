import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function cli(args: string[], extraEnv: Record<string, string | undefined> = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.MERMAIL_API_KEY;
  return spawnSync(process.execPath, ["--import", "tsx", "src/index.ts", ...args], { cwd: process.cwd(), env, encoding: "utf8" });
}

describe("CLI process", () => {
  it("returns stable JSON and exit code 3 without an API key", () => {
    const result = cli(["workspaces", "list"]);
    expect(result.status).toBe(3);
    expect(JSON.parse(result.stderr).error.code).toBe("api_key_required");
    expect(result.stdout).toBe("");
  });

  it("shows operation-specific send flags", () => {
    const result = cli(["emails", "send", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--attachments");
    expect(result.stdout).toContain("--cc");
    expect(result.stdout).not.toContain("--permanent");
  });

  it("does not show email flags on folder commands", () => {
    const result = cli(["folders", "create", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--name");
    expect(result.stdout).not.toContain("--subject");
    expect(result.stdout).not.toContain("--yes");
  });

  it("requires --yes for destructive non-interactive commands before networking", () => {
    const result = cli(["emails", "delete", "--mailbox-id", "box@example.com", "--email-id", "id"]);
    expect(result.status).toBe(4);
    expect(JSON.parse(result.stderr).error.message).toContain("require --yes");
  });

  it("generates subcommand-aware shell completion", () => {
    const result = cli(["completion", "bash"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("workspaces");
    expect(result.stdout).toContain("bulk-delete");
  });
});
