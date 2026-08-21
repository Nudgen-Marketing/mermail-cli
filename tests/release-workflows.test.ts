import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("release orchestration workflows", () => {
  it("publishes the CLI once and notifies the skills repository", () => {
    const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    expect(workflow).not.toContain('tags: ["v*"]');
    expect(workflow).toContain("group: cli-release");
    expect(workflow).toContain("RELEASE_ORCHESTRATOR_TOKEN");
    expect(workflow).toContain("mermail-cli-released");
    expect(workflow).toContain("Nudgen-Marketing/mermail-skills/dispatches");
  });

  it("accepts only the upstream MCP event and forwards a validated contract", () => {
    const workflow = readFileSync(
      join(root, ".github/workflows/upstream-mcp-release.yml"),
      "utf8",
    );
    expect(workflow).toContain("types: [mermail-mcp-released]");
    expect(workflow).toContain('SOURCE_REPOSITORY" == "Nudgen-Marketing/mermail"');
    expect(workflow).toContain("npm run validate:remote");
    expect(workflow).toContain("OPENAPI_SOURCE=spec/openapi.json npm run sync:openapi");
    expect(workflow).toContain("git diff --exit-code -- spec/openapi.json src/generated-schema.ts");
    expect(workflow).toContain("mermail-cli-compatible");
    expect(workflow).toContain("Nudgen-Marketing/mermail-skills/dispatches");
  });
});
