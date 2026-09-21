import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { operations } from "../src/operations.js";
import { operationSchemas } from "../src/generated-schema.js";

const openapi = JSON.parse(
  readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"),
) as {
  components: {
    schemas: {
      Email: {
        properties: Record<string, { type?: string; nullable?: boolean; description?: string }>;
      };
    };
  };
};

describe("operation manifest", () => {
  it("contains exactly the 72 supported Sold API business operations", () => {
    expect(operations).toHaveLength(72);
    expect(new Set(operations.map((operation) => operation.tool)).size).toBe(72);
  });

  it("does not expose console-only API key routes", () => {
    expect(operations.some((operation) => operation.path.includes("api-keys"))).toBe(false);
  });

  it("marks every delete operation as destructive", () => {
    expect(operations.filter((operation) => operation.method === "DELETE").every((operation) => operation.destructive)).toBe(true);
  });

  it("has unique canonical command names", () => {
    const names = operations.map((operation) => `${operation.group} ${operation.action}`);
    expect(new Set(names).size).toBe(names.length);
  });

  it("has a generated OpenAPI schema for every operation", () => {
    expect(Object.keys(operationSchemas).sort()).toEqual(operations.map((operation) => operation.tool).sort());
  });

  it("generates operation-specific fields", () => {
    expect(operationSchemas.get_ai_credit_usage.query).toEqual([]);
    expect(operationSchemas.list_ai_credit_events.query.map((field) => field.name)).toEqual(["cursor", "limit"]);
    expect(operationSchemas.list_ai_credit_events.query.find((field) => field.name === "limit")?.type).toBe("integer");
    expect(operationSchemas.send_email.body.map((field) => field.name)).toContain("attachments");
    expect(operationSchemas.list_emails.query.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        "include_held",
        "metadata_only",
        "require_scan_status",
        "agent_safe_content",
      ]),
    );
    expect(operationSchemas.list_workspaces.body).toEqual([]);
    expect(operationSchemas.create_mailbox.body.find((field) => field.name === "workspaceId")?.required).toBe(false);
    expect(operationSchemas.get_email.query.map((field) => field.name)).toEqual(
      expect.arrayContaining([
        "include_held",
        "metadata_only",
        "require_scan_status",
        "max_body_chars",
        "agent_safe_content",
      ]),
    );
    expect(operationSchemas.get_email_context.query.map((field) => field.name)).toEqual(
      expect.arrayContaining(["limit", "cursor", "include_held"]),
    );
    expect(operationSchemas.search_emails.query.find((field) => field.name === "require_scan_status")?.values).toEqual(["clean", "flagged", "skipped"]);
  });

  it("documents current mailbox response modes and folder deletion effects", () => {
    expect(operations.find((operation) => operation.tool === "update_mailbox_settings")?.description).toContain("draft_for_review");
    expect(operations.find((operation) => operation.tool === "update_mailbox_settings")?.description).toContain("automatic_triage");
    expect(operations.find((operation) => operation.tool === "delete_folder")?.description).toContain("Trash");
  });

  it("keeps the mailbox-first primitives aligned with the MCP operation names", () => {
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "list_mailboxes", group: "mailboxes", action: "list", method: "GET" }),
      expect.objectContaining({ tool: "create_mailbox", group: "mailboxes", action: "create", method: "POST" }),
      expect.objectContaining({ tool: "search_emails", group: "emails", action: "search", method: "GET" }),
      expect.objectContaining({ tool: "get_email", group: "emails", action: "get", method: "GET" }),
      expect.objectContaining({ tool: "get_email_context", group: "emails", action: "context", method: "GET" }),
    ]));
  });

  it("does not expose disabled workspace deletion or default-triager selection", () => {
    expect(operations.some((operation) => operation.tool === "delete_workspace")).toBe(false);
    expect(operations.some((operation) => operation.tool === "set_default_task_triager")).toBe(false);
  });

  it("documents the stable Mermail email id and sender authentication", () => {
    const email = openapi.components.schemas.Email.properties;
    expect(email.id).toMatchObject({ type: "string" });
    expect(email.id?.description).toContain("Use as emailId");
    expect(
      openapi.components.schemas.Email.properties.sender_authentication
        ?.description,
    ).toContain("unknown is not a pass");
  });
});
