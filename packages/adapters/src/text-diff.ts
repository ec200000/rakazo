/**
 * A unified diff of two texts (Myers' algorithm), as `git diff` prints it, for pull request
 * files read from a server that does not hand out diffs itself.
 */

export const TEXT_DIFF_MAX_LINES = 20_000;

type Op = { kind: "same" | "add" | "del"; line: string };

function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset, d);
    }
  }
  return [];
}

function backtrack(trace: Int32Array[], a: string[], b: string[], offset: number, end: number) {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = end; d > 0; d -= 1) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
        ? k + 1
        : k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      ops.push({ kind: "same", line: a[x] as string });
    }
    if (x === prevX) {
      y -= 1;
      ops.push({ kind: "add", line: b[y] as string });
    } else {
      x -= 1;
      ops.push({ kind: "del", line: a[x] as string });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    ops.push({ kind: "same", line: a[x] as string });
  }
  return ops.reverse();
}

function lines(text: string): string[] {
  if (text === "") return [];
  const parts = text.replace(/\r\n/g, "\n").split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/**
 * The unified diff from `before` to `after` with `context` lines around each change; null for
 * null (a file that does not exist on that side). Returns "" when the texts are equal.
 */
export function unifiedDiff(
  path: string,
  before: string | null,
  after: string | null,
  context = 3,
): { diff: string; additions: number; deletions: number; truncated: boolean } {
  const a = lines(before ?? "");
  const b = lines(after ?? "");
  if (a.length + b.length > TEXT_DIFF_MAX_LINES) {
    return { diff: "", additions: 0, deletions: 0, truncated: true };
  }
  const ops = diffLines(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === "add") additions += 1;
    else if (op.kind === "del") deletions += 1;
  }
  if (additions === 0 && deletions === 0)
    return { diff: "", additions, deletions, truncated: false };
  const header = [
    `diff --git a${path} b${path}`,
    ...(before === null
      ? ["new file mode 100644"]
      : after === null
        ? ["deleted file mode 100644"]
        : []),
    before === null ? "--- /dev/null" : `--- a${path}`,
    after === null ? "+++ /dev/null" : `+++ b${path}`,
  ];
  const out: string[] = [...header];
  // Positions (old and new line numbers) of every op, then group changes into hunks.
  let oldLine = 1;
  let newLine = 1;
  const positioned = ops.map((op) => {
    const at = { ...op, oldLine, newLine };
    if (op.kind !== "add") oldLine += 1;
    if (op.kind !== "del") newLine += 1;
    return at;
  });
  let i = 0;
  while (i < positioned.length) {
    while (i < positioned.length && positioned[i]?.kind === "same") i += 1;
    if (i >= positioned.length) break;
    let start = Math.max(0, i - context);
    let end = i;
    // Extend the hunk while the next change is within 2 * context unchanged lines.
    for (;;) {
      while (end < positioned.length && positioned[end]?.kind !== "same") end += 1;
      let gap = end;
      while (gap < positioned.length && positioned[gap]?.kind === "same") gap += 1;
      if (gap < positioned.length && gap - end <= context * 2) {
        end = gap;
        continue;
      }
      end = Math.min(positioned.length, end + context);
      break;
    }
    const hunk = positioned.slice(start, end);
    const first = hunk[0] as (typeof positioned)[number];
    const oldCount = hunk.filter((op) => op.kind !== "add").length;
    const newCount = hunk.filter((op) => op.kind !== "del").length;
    const oldStart = oldCount === 0 ? first.oldLine - 1 : first.oldLine;
    const newStart = newCount === 0 ? first.newLine - 1 : first.newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk) {
      out.push(`${op.kind === "add" ? "+" : op.kind === "del" ? "-" : " "}${op.line}`);
    }
    i = end;
    start = end;
  }
  return { diff: `${out.join("\n")}\n`, additions, deletions, truncated: false };
}
