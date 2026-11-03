// Pure parsing of a unified diff (git diff / git show / git stash show -p) into
// files and rows the phone can draw. Plain JS rather than TypeScript so the repo's
// node:test suite can import it — see test/mobile-diff-parse.test.mjs.

/**
 * @typedef {{ kind: 'hunk' | 'add' | 'del' | 'ctx' | 'meta', text: string, oldLine?: number, newLine?: number }} DiffRow
 * @typedef {{ path: string, oldPath?: string, binary: boolean, additions: number, deletions: number, rows: DiffRow[] }} DiffFile
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

// `a/src/x.js` -> `src/x.js`; `/dev/null` stays as-is so a new/deleted file can tell.
function stripPrefix(p) {
  return p.replace(/^[ab]\//, '');
}

/**
 * @param {string} patch
 * @returns {DiffFile[]}
 */
export function parseUnifiedDiff(patch) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  const startFile = (path) => {
    file = { path, binary: false, additions: 0, deletions: 0, rows: [] };
    files.push(file);
    inHunk = false;
  };

  for (const line of String(patch || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      startFile(m ? m[2] : line.slice('diff --git '.length));
      continue;
    }
    // A bare hunk with no `diff --git` header (some callers send just the hunks).
    if (!file && (line.startsWith('--- ') || line.startsWith('@@'))) startFile('');
    if (!file) continue;

    if (!inHunk) {
      if (line.startsWith('--- ')) {
        const p = line.slice(4).trim();
        if (p !== '/dev/null') file.oldPath = stripPrefix(p);
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = line.slice(4).trim();
        if (p !== '/dev/null') file.path = stripPrefix(p);
        else if (file.oldPath) file.path = file.oldPath;
        continue;
      }
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
        file.binary = true;
        continue;
      }
      if (line.startsWith('rename from ')) { file.oldPath = line.slice('rename from '.length); continue; }
      if (line.startsWith('rename to ')) { file.path = line.slice('rename to '.length); continue; }
    }

    const hunk = line.match(HUNK_HEADER);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.rows.push({ kind: 'hunk', text: line });
      continue;
    }
    if (!inHunk) continue; // index/mode lines between the header and the first hunk

    if (line.startsWith('+')) {
      file.rows.push({ kind: 'add', text: line.slice(1), newLine: newLine++ });
      file.additions++;
    } else if (line.startsWith('-')) {
      file.rows.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++ });
      file.deletions++;
    } else if (line.startsWith('\\')) {
      file.rows.push({ kind: 'meta', text: line });
    } else if (line.startsWith(' ') || line === '') {
      // A trailing '' is just the split's artefact after the patch's last newline;
      // inside a hunk a real empty context line arrives as ' '.
      if (line === '') continue;
      file.rows.push({ kind: 'ctx', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return files;
}

/**
 * Totals across every file of a parsed diff.
 * @param {DiffFile[]} files
 */
export function diffTotals(files) {
  return files.reduce(
    (t, f) => ({ files: t.files + 1, additions: t.additions + f.additions, deletions: t.deletions + f.deletions }),
    { files: 0, additions: 0, deletions: 0 },
  );
}
