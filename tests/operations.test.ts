import { describe, expect, it } from "vitest";
import { operations } from "../src/operations.js";

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
});
