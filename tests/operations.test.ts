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
  it("contains exactly the 71 Sold API business operations", () => {
    expect(operations).toHaveLength(71);
    expect(new Set(operations.map((operation) => operation.tool)).size).toBe(71);
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
    expect(operationSchemas.send_email.body.map((field) => field.name)).toContain("attachments");
    expect(operationSchemas.list_emails.query.map((field) => field.name)).toContain("category");
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
    expect(operationSchemas.search_emails.query.find((field) => field.name === "require_scan_status")?.values).toEqual(["clean", "flagged", "skipped"]);
  });

  it("keeps the mailbox-first primitives aligned with the MCP operation names", () => {
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "list_mailboxes", group: "mailboxes", action: "list", method: "GET" }),
      expect.objectContaining({ tool: "create_mailbox", group: "mailboxes", action: "create", method: "POST" }),
      expect.objectContaining({ tool: "search_emails", group: "emails", action: "search", method: "GET" }),
      expect.objectContaining({ tool: "get_email", group: "emails", action: "get", method: "GET" }),
    ]));
  });

  it("documents the stable Mermail id and secondary provider message id", () => {
    const email = openapi.components.schemas.Email.properties;
    const messageId = email.message_id as {
      type?: string | string[];
      nullable?: boolean;
      description?: string;
    };
    expect(email.id).toMatchObject({ type: "string" });
    expect(email.id?.description).toContain("Authoritative Mermail email id");
    expect(
      messageId.nullable === true ||
        (Array.isArray(messageId.type) &&
          messageId.type.includes("string") &&
          messageId.type.includes("null")),
    ).toBe(true);
    expect(messageId.description).toContain("secondary correlation");
    expect(
      openapi.components.schemas.Email.properties.sender_authentication
        ?.description,
    ).toContain("unknown is not a pass");
  });
});
