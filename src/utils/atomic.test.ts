import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { readText, replaceManagedBlock } from "./atomic.js";

describe("replaceManagedBlock", () => {
  it("inserts new block when markers not present", () => {
    const result = replaceManagedBlock(
      "existing content",
      "<!-- start -->",
      "<!-- end -->",
      "new content",
    );
    expect(result).toBe("existing content\n\n<!-- start -->\nnew content\n<!-- end -->\n");
  });

  it("replaces existing block", () => {
    const current = "before\n<!-- start -->\nold\n<!-- end -->\nafter";
    const result = replaceManagedBlock(
      current,
      "<!-- start -->",
      "<!-- end -->",
      "new",
    );
    expect(result).toBe("before\n<!-- start -->\nnew\n<!-- end -->\nafter\n");
  });

  it("throws on malformed block", () => {
    expect(() =>
      replaceManagedBlock(
        "<!-- start -->\nno end",
        "<!-- start -->",
        "<!-- end -->",
        "body",
      ),
    ).toThrow("Malformed managed block");
  });

  it("is idempotent", () => {
    const first = replaceManagedBlock(
      "",
      "<!-- start -->",
      "<!-- end -->",
      "content",
    );
    const second = replaceManagedBlock(
      first,
      "<!-- start -->",
      "<!-- end -->",
      "content",
    );
    expect(first).toBe(second);
  });

  it("does not collapse blank lines outside the managed block", () => {
    const current = "Intro\n\n\n\nKeep these blanks.\n<!-- start -->\nold\n<!-- end -->\n";
    const first = replaceManagedBlock(current, "<!-- start -->", "<!-- end -->", "new");
    const second = replaceManagedBlock(first, "<!-- start -->", "<!-- end -->", "new");
    expect(first).toContain("Intro\n\n\n\nKeep these blanks.");
    expect(second).toBe(first);
  });
});

describe("readText", () => {
  it("returns empty string for a directory instead of throwing EISDIR", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "teamrecall-readdir-"));
    await expect(readText(dir)).resolves.toBe("");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
