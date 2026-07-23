import { describe, expect, it } from "vitest";
import { operations } from "../src/operations.js";
import { operationSchemas } from "../src/generated-schema.js";

describe("operation manifest", () => {
  it("contains exactly the 62 Sold API business operations", () => {
    expect(operations).toHaveLength(62);
    expect(new Set(operations.map((operation) => operation.tool)).size).toBe(62);
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
    expect(operationSchemas.list_workspaces.body).toEqual([]);
  });

  it("keeps the mailbox-first primitives aligned with the MCP operation names", () => {
    expect(operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ tool: "list_mailboxes", group: "mailboxes", action: "list", method: "GET" }),
      expect.objectContaining({ tool: "create_mailbox", group: "mailboxes", action: "create", method: "POST" }),
      expect.objectContaining({ tool: "search_emails", group: "emails", action: "search", method: "GET" }),
      expect.objectContaining({ tool: "get_email", group: "emails", action: "get", method: "GET" }),
    ]));
  });
});
