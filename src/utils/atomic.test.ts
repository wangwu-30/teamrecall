import { describe, expect, it } from "vitest";
import { replaceManagedBlock } from "./atomic.js";

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
});
