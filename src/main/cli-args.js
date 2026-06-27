// Pure parser for the app's command-line flags. Kept Electron-free so it's
// unit-testable; repo.js reads process.argv, validates the path, and applies it.
//
// The only flag today is a folder override: it makes a launched instance open a
// specific directory instead of the persisted last folder. This is what lets the
// "Start IDE" launch config open a throwaway test workspace (so developing the
// IDE *with* the IDE doesn't have the test instance fight over the real repo).

// Return the folder passed via `--folder <path>` / `--folder=<path>` (alias
// `--dir`), or null when absent. The first occurrence wins.
function parseFolderArg(argv) {
  const args = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--folder' || a === '--dir') return args[i + 1] || null;
    const m = /^--(?:folder|dir)=(.*)$/.exec(a);
    if (m) return m[1] || null;
  }
  return null;
}

module.exports = { parseFolderArg };
