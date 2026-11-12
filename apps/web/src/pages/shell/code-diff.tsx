import { Trans } from "@lingui/react/macro";

type DiffLine =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "same"; text: string; oldLine: number | null; newLine: number | null }
  | { kind: "note"; text: string };

/** Reads a unified diff (one file) into display lines with old and new line numbers. */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: "hunk", text: raw });
      continue;
    }
    if (!inHunk) {
      if (raw.startsWith("Binary files")) lines.push({ kind: "note", text: raw });
      continue;
    }
    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "del", text: raw.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else if (raw.startsWith(" ")) {
      lines.push({ kind: "same", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    } else if (raw.startsWith("\\")) {
      lines.push({ kind: "note", text: raw.slice(2) });
    } else if (raw.startsWith("diff --git")) {
      inHunk = false;
    }
  }
  return lines;
}

const ROW: Record<string, string> = {
  add: "bg-success/15",
  del: "bg-destructive/15",
  same: "",
};
const SIGN: Record<string, string> = { add: "+", del: "-", same: " " };

/** A unified diff with line numbers, additions in green and deletions in red. */
export function DiffView({ diff, truncated }: { diff: string; truncated?: boolean }) {
  const lines = parseUnifiedDiff(diff);
  if (lines.length === 0) {
    return (
      <p className="px-3 py-2 text-body-sm text-muted-foreground">
        <Trans>No differences to show.</Trans>
      </p>
    );
  }
  return (
    <div className="overflow-x-auto font-mono text-label leading-[18px]" data-testid="diff-view">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, index) =>
            line.kind === "hunk" || line.kind === "note" ? (
              <tr key={index} className="bg-muted/60 text-muted-foreground">
                <td colSpan={4} className="whitespace-pre px-3 py-0.5">
                  {line.text}
                </td>
              </tr>
            ) : (
              <tr key={index} className={ROW[line.kind]} data-kind={line.kind}>
                <td className="w-10 select-none pe-2 text-end align-top text-muted-foreground/70">
                  {line.oldLine ?? ""}
                </td>
                <td className="w-10 select-none pe-2 text-end align-top text-muted-foreground/70">
                  {line.newLine ?? ""}
                </td>
                <td className="w-4 select-none align-top text-muted-foreground">
                  {SIGN[line.kind]}
                </td>
                <td className="whitespace-pre pe-3 align-top">{line.text}</td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {truncated ? (
        <p className="px-3 py-2 text-body-sm text-muted-foreground">
          <Trans>This diff is too long to show in full.</Trans>
        </p>
      ) : null}
    </div>
  );
}
