import { describe, expect, it } from "vitest";
import { formatMemory, generateMemoryId, parseMemory, slugify } from "./memory.js";
import type { MemoryFrontmatter } from "./types.js";

describe("parseMemory", () => {
  it("parses valid memory", () => {
    const content = `---
id: M-001
kind: gotcha
paths: ["src/**/*.ts"]
evidence:
  pr: "#42"
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Use retries only in the gateway wrapper.`;

    const result = parseMemory(content);
    expect(result).toBeTruthy();
    expect(result?.frontmatter.id).toBe("M-001");
    expect(result?.frontmatter.kind).toBe("gotcha");
    expect(result?.body).toBe("Use retries only in the gateway wrapper.");
  });

  it("returns null for invalid frontmatter", () => {
    const content = `---
id: M-001
---
Body`;
    expect(parseMemory(content)).toBeNull();
  });

  it("returns null for missing frontmatter", () => {
    expect(parseMemory("Just body text")).toBeNull();
  });
});

describe("formatMemory", () => {
  it("formats memory correctly", () => {
    const frontmatter: MemoryFrontmatter = {
      id: "M-001",
      kind: "gotcha",
      paths: ["src/**/*.ts"],
      evidence: { pr: "#42" },
      author: "alice",
      created: "2026-10-10",
      review_after: "2027-01-08",
      status: "active",
    };
    const body = "Use retries only in the gateway wrapper.";

    const formatted = formatMemory(frontmatter, body);
    expect(formatted).toContain("---");
    expect(formatted).toContain("id: M-001");
    expect(formatted).toContain("Use retries only in the gateway wrapper.");
  });
});

describe("generateMemoryId", () => {
  it("generates M-001 for empty list", () => {
    expect(generateMemoryId([])).toBe("M-001");
  });

  it("increments from existing IDs", () => {
    expect(generateMemoryId(["M-001", "M-002"])).toBe("M-003");
    expect(generateMemoryId(["M-005", "M-001"])).toBe("M-006");
  });

  it("handles non-numeric IDs", () => {
    expect(generateMemoryId(["M-abc", "M-001"])).toBe("M-002");
  });
});

describe("slugify", () => {
  it("converts to kebab-case", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Use Retry Logic")).toBe("use-retry-logic");
  });

  it("handles special characters", () => {
    expect(slugify("API/Gateway: Retry")).toBe("api-gateway-retry");
  });

  it("truncates long strings", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(40);
  });
});
