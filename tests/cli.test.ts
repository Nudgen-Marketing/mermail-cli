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
    expect(result.stdout).toContain("wait");
    expect(result.stdout).toContain("ensure");
  });

  it("documents the additive verification-email wait command", () => {
    const result = cli(["emails", "wait", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--mailbox-id");
    expect(result.stdout).toContain("--subject");
    expect(result.stdout).toContain("--from-exact");
    expect(result.stdout).toContain("--to-exact");
    expect(result.stdout).toContain("--require-single-match");
    expect(result.stdout).toContain("--metadata-only");
    expect(result.stdout).toContain("--after");
    expect(result.stdout).toContain("--exclude-email-id");
    expect(result.stdout.replace(/\s+/g, " ")).toContain('default: "30000"');
    expect(result.stdout).toContain("At least one semantic filter");
  });

  it("exposes held-mail and metadata controls on direct list/search/get commands", () => {
    const list = cli(["emails", "list", "--help"]);
    const search = cli(["emails", "search", "--help"]);
    const get = cli(["emails", "get", "--help"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("--include-held");
    expect(list.stdout).toContain("--include_held");
    expect(list.stdout).toContain("--metadata-only");
    expect(list.stdout).toContain("--metadata_only");
    expect(list.stdout).toContain("--require-scan-status");
    expect(list.stdout).toContain("--agent-safe-content");
    expect(search.status).toBe(0);
    expect(search.stdout).toContain("--require-scan-status");
    expect(search.stdout).toContain("--require_scan_status");
    expect(search.stdout).toContain("--include-held");
    expect(search.stdout).toContain("--metadata-only");
    expect(search.stdout).toContain("--agent-safe-content");
    expect(get.status).toBe(0);
    expect(get.stdout).toContain("--include-held");
    expect(get.stdout).toContain("--metadata-only");
    expect(get.stdout).toContain("--require-scan-status");
    expect(get.stdout).toContain("--max-body-chars");
    expect(get.stdout).toContain("--agent-safe-content");
  });

  it("exposes bounded email context and omits retired CLI workflows", () => {
    const context = cli(["emails", "context", "--help"]);
    const wallet = cli(["wallet", "--help"]);
    const workspaces = cli(["workspaces", "--help"]);
    const triagers = cli(["triagers", "--help"]);
    expect(context.status).toBe(0);
    expect(context.stdout).toContain("--email-id");
    expect(context.stdout).toContain("--limit");
    expect(context.stdout).toContain("--cursor");
    expect(context.stdout).toContain("--include-held");
    expect(wallet.stdout).not.toContain("sign-url");
    expect(workspaces.stdout).not.toContain("delete");
    expect(triagers.stdout).not.toContain("set-default");
  });

  it("rejects an empty repeated baseline email id before networking", () => {
    const result = cli([
      "emails", "wait",
      "--mailbox-id", "box@example.com",
      "--subject", "Verify",
      "--exclude-email-id", "",
      "--api-key", "sk-proj-test",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("--exclude-email-id");
  });

  it("requires a semantic email filter before waiting or networking", () => {
    const result = cli(["emails", "wait", "--mailbox-id", "box@example.com", "--api-key", "sk-proj-test"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("requires at least one semantic filter");
  });

  it("does not accept --after alone as a semantic email filter", () => {
    const result = cli([
      "emails", "wait",
      "--mailbox-id", "box@example.com",
      "--after", "2026-07-23T09:55:00Z",
      "--api-key", "sk-proj-test",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("--from-exact");
  });

  it("requires an RFC3339 timezone for the safe after boundary", () => {
    const result = cli([
      "emails", "wait",
      "--mailbox-id", "box@example.com",
      "--subject", "Verify",
      "--after", "2026-07-23T09:55:00",
      "--api-key", "sk-proj-test",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("RFC3339");
  });

  it("rejects an impossible RFC3339 calendar date", () => {
    const result = cli([
      "emails", "wait",
      "--mailbox-id", "box@example.com",
      "--subject", "Verify",
      "--after", "2026-02-31T09:55:00Z",
      "--api-key", "sk-proj-test",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("valid RFC3339");
  });

  it("documents mailbox ensure without making workspace-id mandatory", () => {
    const result = cli(["mailboxes", "ensure", "--help"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--email");
    expect(result.stdout).toContain("--name");
    expect(result.stdout).toContain("--workspace-id");
    expect(result.stdout).toContain("--verification-mode");
    expect(result.stdout).not.toContain("requiredOption");
  });

  it("parses object-valued mailbox settings and rejects malformed JSON before networking", () => {
    const result = cli([
      "mailboxes", "create",
      "--email", "agent@mermail.app",
      "--name", "Agent",
      "--settings", "not-json",
      "--api-key", "sk-proj-test",
    ]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr).error.message).toContain("JSON object");
  });
});
