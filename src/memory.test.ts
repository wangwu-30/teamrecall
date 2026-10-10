import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clampBody,
  countWords,
  formatMemory,
  generateMemoryId,
  isValidFrontmatter,
  loadMemories,
  parseMemory,
  reviewAfterDate,
  slugify,
  validateMemoryBody,
} from "./memory.js";
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

  it("rejects an id that is not M-digits", () => {
    expect(isValidFrontmatter({
      id: "memory-1",
      kind: "gotcha",
      paths: ["src/**"],
      author: "a",
      created: "2026-10-10",
      review_after: "2027-01-08",
      status: "active",
    })).toBe(false);
  });
});

describe("body limits", () => {
  it("counts and clamps to 120 words", () => {
    const words = Array.from({ length: 130 }, (_, index) => `w${index}`).join(" ");
    expect(countWords(words)).toBe(130);
    expect(validateMemoryBody(words)[0]).toMatch(/120/);
    expect(countWords(clampBody(words))).toBe(120);
  });
});

describe("reviewAfterDate", () => {
  it("defaults to +90 days", () => {
    expect(reviewAfterDate("2026-10-10")).toBe("2027-01-08");
  });
});

describe("loadMemories", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("reads valid M-*.md files and skips junk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-mem-"));
    dirs.push(dir);
    const folder = path.join(dir, ".memory", "memories");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, "M-001-retry.md"), `---
id: M-001
kind: gotcha
paths: ["src/**"]
author: alice
created: "2026-10-10"
review_after: "2027-01-08"
status: active
---

Use retries only in the gateway wrapper.`, "utf8");
    await fs.writeFile(path.join(folder, "notes.md"), "ignore", "utf8");
    const loaded = await loadMemories(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].frontmatter.id).toBe("M-001");
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
