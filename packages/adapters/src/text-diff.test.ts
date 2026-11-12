import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { unifiedDiff } from "./text-diff.js";

const dir = mkdtempSync(join(tmpdir(), "text-diff-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Applies our diff with git and returns the result, so the hunks must be exactly right. */
function applied(before: string | null, after: string | null) {
  const work = mkdtempSync(join(dir, "case-"));
  execFileSync("git", ["init", "-q"], { cwd: work });
  if (before !== null) writeFileSync(join(work, "f.txt"), before);
  const { diff } = unifiedDiff("/f.txt", before, after);
  writeFileSync(join(work, "p.diff"), diff);
  execFileSync("git", ["apply", "--unidiff-zero", "p.diff"], { cwd: work });
  try {
    return readFileSync(join(work, "f.txt"), "utf8");
  } catch {
    return null;
  }
}

function random(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe("unified diff", () => {
  it("counts and shows a small change", () => {
    const result = unifiedDiff("/a.ts", "one\ntwo\nthree\n", "one\n2\nthree\nfour\n");
    expect(result.additions).toBe(2);
    expect(result.deletions).toBe(1);
    expect(result.diff).toContain("@@ -1,3 +1,4 @@\n one\n-two\n+2\n three\n+four\n");
  });

  it("handles new and deleted files", () => {
    expect(applied(null, "a\nb\n")).toBe("a\nb\n");
    expect(unifiedDiff("/x", "a\n", null).diff).toContain("+++ /dev/null");
    expect(unifiedDiff("/x", "same\n", "same\n").diff).toBe("");
  });

  it("produces patches git applies, for many random edits", () => {
    const next = random(42);
    for (let round = 0; round < 60; round += 1) {
      const base = Array.from({ length: 5 + Math.floor(next() * 60) }, (_, i) => `line ${i}`);
      const edited = [...base];
      for (let edits = Math.floor(next() * 8); edits > 0; edits -= 1) {
        const at = Math.floor(next() * (edited.length + 1));
        const roll = next();
        if (roll < 0.4) edited.splice(at, 0, `new ${round}-${edits}`);
        else if (roll < 0.7) edited.splice(at, 1);
        else edited[at] = `changed ${round}-${edits}`;
      }
      const before = `${base.join("\n")}\n`;
      const after = `${edited.filter((line) => line !== undefined).join("\n")}\n`;
      if (before === after) continue;
      expect(applied(before, after)).toBe(after);
    }
  });
});
