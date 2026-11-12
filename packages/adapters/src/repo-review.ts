/**
 * What a bot changed in its repository, for the Changes panel beside the chat: the files its
 * working branch changes against the base branch (committed or not), its commits, and one
 * file's diff. Everything runs as fixed, read-only git scripts in the bot's computer, with the
 * branch, folder and path passed as environment variables; nothing here needs the network or a
 * credential, and GIT_OPTIONAL_LOCKS=0 keeps it from contending with the bot's own git.
 */

export const REPO_DIFF_MAX_BYTES = 400_000;
export const REPO_CHANGES_MAX_FILES = 500;
const MAX_COMMITS = 50;

export type RepoChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "typechange"
  | "untracked"
  | "conflict";

export type RepoChange = {
  path: string;
  status: RepoChangeStatus;
  /** Null for binary files. */
  additions: number | null;
  deletions: number | null;
  /** Changed in the folder but not committed yet. */
  uncommitted: boolean;
};

export type RepoChanges = {
  state: "not-cloned" | "ready";
  branch: string | null;
  /** The commit the branch started from on the base branch; null before the base is fetched. */
  mergeBase: string | null;
  /** Commits on the remote branch not here, and commits here not pushed. Null without upstream. */
  behind: number | null;
  ahead: number | null;
  commits: { sha: string; subject: string }[];
  files: RepoChange[];
  truncated: boolean;
};

const PRELUDE = `export GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 LC_ALL=C
cd "$REPO_DIR" 2>/dev/null && [ -e .git ] || { echo "@@STATE not-cloned"; exit 0; }
g() { git -c core.quotePath=false "$@"; }
base=""
if g rev-parse --verify --quiet "refs/remotes/origin/$REPO_BASE^{commit}" >/dev/null; then
  base=$(g merge-base "refs/remotes/origin/$REPO_BASE" HEAD 2>/dev/null || true)
fi
if [ -z "$base" ]; then base=$(g rev-parse --verify --quiet HEAD 2>/dev/null || true); fi
`;

/** Prints the branch, its sync state, commits and changed files in @@-marked sections. */
export const REPO_CHANGES_SCRIPT = `${PRELUDE}echo "@@STATE ready"
echo "@@BRANCH $(g symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
echo "@@BASE $base"
echo "@@SYNC $(g rev-list --left-right --count '@{upstream}...HEAD' 2>/dev/null || true)"
echo "@@COMMITS"
if [ -n "$base" ]; then g log --no-merges --format='%h %s' -n ${MAX_COMMITS} "$base..HEAD" 2>/dev/null || true; fi
echo "@@NUMSTAT"
if [ -n "$base" ]; then g diff --no-renames --numstat "$base" 2>/dev/null || true; fi
echo "@@NAMESTATUS"
if [ -n "$base" ]; then g diff --no-renames --name-status "$base" 2>/dev/null || true; fi
echo "@@STATUS"
g status --porcelain=v1 --untracked-files=all --no-renames 2>/dev/null | head -n ${REPO_CHANGES_MAX_FILES + 1}
echo "@@UNTRACKED"
g ls-files --others --exclude-standard 2>/dev/null | head -n ${REPO_CHANGES_MAX_FILES + 1} | while IFS= read -r f; do
  if [ -f "$f" ]; then g diff --no-index --numstat -- /dev/null "$f" 2>/dev/null | head -n 1; fi
done
echo "@@END"`;

/** Prints one file's diff against the base, or the whole file for an untracked one. */
export const REPO_FILE_DIFF_SCRIPT = `${PRELUDE}if [ -n "$(g ls-files --others --exclude-standard -- "$REPO_PATH" 2>/dev/null)" ]; then
  g diff --no-index --no-color -- /dev/null "$REPO_PATH" 2>/dev/null | head -c ${REPO_DIFF_MAX_BYTES + 1}
elif [ -n "$base" ]; then
  g diff --no-renames --no-color "$base" -- "$REPO_PATH" 2>/dev/null | head -c ${REPO_DIFF_MAX_BYTES + 1}
fi
exit 0`;

/** A path inside the repository folder, as git prints it: relative, with no `..` or `.git`. */
export function isRepoRelativePath(value: string): boolean {
  if (!value || value.length > 1000 || value.startsWith("/") || value.startsWith("-")) {
    return false;
  }
  if (/[\0\n\r\\]/.test(value)) return false;
  return value
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

/** Undoes git's C-style quoting of unusual paths ("a b", tabs, quotes, non-ASCII as octal). */
export function unquoteGitPath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const bytes: number[] = [];
  const body = value.slice(1, -1);
  const simple: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    '"': '"',
    "\\": "\\",
    a: "\x07",
    b: "\b",
    f: "\f",
    v: "\v",
  };
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char));
      continue;
    }
    const next = body[i + 1] ?? "";
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(simple[next] ?? next));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function count(value: string | undefined): number | null {
  return value === undefined || value === "-" ? null : Number.parseInt(value, 10) || 0;
}

function sections(stdout: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of stdout.split("\n")) {
    const marker = /^@@([A-Z]+)(?: (.*))?$/.exec(line);
    if (marker) {
      current = [];
      result.set(marker[1] as string, marker[2] === undefined ? current : [marker[2]]);
      if (marker[2] !== undefined) current = null;
      continue;
    }
    if (current && line !== "") current.push(line);
  }
  return result;
}

function numstat(
  line: string,
): { path: string; additions: number | null; deletions: number | null } | null {
  const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
  if (!match) return null;
  return {
    additions: count(match[1]),
    deletions: count(match[2]),
    path: unquoteGitPath(match[3] as string),
  };
}

const NAME_STATUS: Record<string, RepoChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  T: "typechange",
  U: "conflict",
};

/** Reads REPO_CHANGES_SCRIPT's output. */
export function parseRepoChanges(stdout: string): RepoChanges {
  const parts = sections(stdout);
  if (parts.get("STATE")?.[0] !== "ready") {
    return {
      state: "not-cloned",
      branch: null,
      mergeBase: null,
      behind: null,
      ahead: null,
      commits: [],
      files: [],
      truncated: false,
    };
  }
  const sync = /^(\d+)\s+(\d+)$/.exec(parts.get("SYNC")?.[0]?.trim() ?? "");
  const files = new Map<string, RepoChange>();
  for (const line of parts.get("NAMESTATUS") ?? []) {
    const [code = "", ...rest] = line.split("\t");
    const path = unquoteGitPath(rest.join("\t"));
    if (!path) continue;
    files.set(path, {
      path,
      status: NAME_STATUS[code[0] ?? ""] ?? "modified",
      additions: null,
      deletions: null,
      uncommitted: false,
    });
  }
  for (const line of parts.get("NUMSTAT") ?? []) {
    const stat = numstat(line);
    const file = stat && files.get(stat.path);
    if (stat && file) Object.assign(file, { additions: stat.additions, deletions: stat.deletions });
  }
  for (const line of parts.get("STATUS") ?? []) {
    const path = unquoteGitPath(line.slice(3));
    const code = line.slice(0, 2);
    if (!path) continue;
    const file = files.get(path);
    if (file) file.uncommitted = true;
    else if (code === "??") {
      files.set(path, {
        path,
        status: "untracked",
        additions: null,
        deletions: null,
        uncommitted: true,
      });
    } else if (code.includes("U") || code === "AA" || code === "DD") {
      files.set(path, {
        path,
        status: "conflict",
        additions: null,
        deletions: null,
        uncommitted: true,
      });
    }
  }
  for (const line of parts.get("UNTRACKED") ?? []) {
    const stat = numstat(line);
    if (!stat) continue;
    // git diff --no-index prints the new side's path, which is the untracked file itself.
    const file = files.get(stat.path.replace(/^\/dev\/null => /, ""));
    if (file) Object.assign(file, { additions: stat.additions, deletions: stat.deletions });
  }
  const list = [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    state: "ready",
    branch: parts.get("BRANCH")?.[0]?.trim() || null,
    mergeBase: parts.get("BASE")?.[0]?.trim() || null,
    behind: sync ? Number(sync[1]) : null,
    ahead: sync ? Number(sync[2]) : null,
    commits: (parts.get("COMMITS") ?? []).flatMap((line) => {
      const space = line.indexOf(" ");
      return space > 0 ? [{ sha: line.slice(0, space), subject: line.slice(space + 1) }] : [];
    }),
    files: list.slice(0, REPO_CHANGES_MAX_FILES),
    truncated: list.length > REPO_CHANGES_MAX_FILES,
  };
}

/** Reads REPO_FILE_DIFF_SCRIPT's output. */
export function parseRepoFileDiff(stdout: string): { diff: string; truncated: boolean } {
  if (stdout.startsWith("@@STATE not-cloned")) return { diff: "", truncated: false };
  const truncated = Buffer.byteLength(stdout) > REPO_DIFF_MAX_BYTES;
  return {
    diff: truncated ? Buffer.from(stdout).subarray(0, REPO_DIFF_MAX_BYTES).toString() : stdout,
    truncated,
  };
}
