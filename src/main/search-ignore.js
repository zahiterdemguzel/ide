// Directories that explorer search (filename + references) skips: dependency
// caches and build output that bury real results and would otherwise blow past
// the result cap. The file tree itself still shows them (see list-dir) so they
// stay browsable — this only prunes what search walks. Pure data + helpers, no
// electron/IO, so it's unit-tested directly.

// Grouped by ecosystem for readability; flattened into one lookup set below.
const IGNORED_DIR_GROUPS = {
  vcs: ['.git', '.hg', '.svn'],
  node: ['node_modules', '.next', '.nuxt', '.svelte-kit', 'bower_components'],
  python: ['venv', '.venv', 'env', '__pycache__', '.pytest_cache',
    '.mypy_cache', '.ruff_cache', '.tox', '.eggs', 'site-packages'],
  rustGo: ['target', 'vendor'],
  jvmDotnet: ['.gradle', 'bin', 'obj', '.idea', '.vs'],
  build: ['dist', 'build', 'out', 'coverage', '.cache', '.parcel-cache',
    '.turbo', '.output'],
};

const IGNORED_DIRS = new Set(Object.values(IGNORED_DIR_GROUPS).flat());

// Dot-prefixed dirs that DO hold real, searchable content and so must stay
// visible to search despite the catch-all dot rule below. A blanket
// "skip anything starting with ." is too aggressive: it would bury CI configs
// and — for this app specifically — the .vscode launch.json/tasks.json that the
// run toolbar is built from.
const DOT_DIR_ALLOWLIST = new Set(['.github', '.vscode']);

// Should the walker skip descending into a directory of this name? Skips the
// named dependency/build dirs above, plus any other dot-prefixed dir (tooling
// and cache state like .terraform, .docusaurus, .angular that we don't want to
// enumerate exhaustively) except the allowlisted ones.
function shouldSkipDir(name) {
  if (IGNORED_DIRS.has(name)) return true;
  return name.startsWith('.') && !DOT_DIR_ALLOWLIST.has(name);
}

// git-grep pathspecs that exclude every named ignored dir at any depth, so the
// references search prunes the same folders the filename walk does (git grep
// already honours .gitignore, but --untracked would otherwise dive into e.g. an
// un-ignored node_modules). Magic `:(exclude)` == `:!`.
//
// Unlike shouldSkipDir, this does NOT add a catch-all `**/.*/**` exclude for
// un-named dot-dirs: git pathspec exclusion is all-or-nothing per glob with no
// way to re-include the allowlist, and adding a *positive* pathspec for the
// allowlist would flip grep into "search only these" mode. The asymmetry is
// harmless in practice — git grep already skips .gitignore'd dot-dirs (.next,
// .venv, …), so the catch-all only mattered for the .gitignore-blind disk walk.
const GREP_EXCLUDE_PATHSPECS = [...IGNORED_DIRS].map((d) => `:(exclude,glob)**/${d}/**`);

module.exports = {
  IGNORED_DIRS, IGNORED_DIR_GROUPS, DOT_DIR_ALLOWLIST, shouldSkipDir, GREP_EXCLUDE_PATHSPECS,
};
