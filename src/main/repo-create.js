// Pure logic for "create a repository" (the git pane's new-repo panel). No
// electron, no subprocess — git.js runs `git init`/`commit`/`gh repo create`, this
// file just validates the chosen name and builds the `gh` argv, so the fiddly bits
// (name rules, flag assembly) are unit-testable on their own.

// GitHub repository names allow ASCII letters, digits, '-', '_', and '.'. Anything
// else (spaces, slashes, …) is rejected by the API, so we catch it up front with a
// clear message instead of letting `gh` fail with a wall of text. '.' and '..' are
// also refused by GitHub.
function validateRepoName(name) {
  const n = (name || '').trim();
  if (!n) return { ok: false, error: 'Repository name is required' };
  if (n === '.' || n === '..') return { ok: false, error: 'Repository name cannot be "." or ".."' };
  if (!/^[A-Za-z0-9._-]+$/.test(n)) {
    return { ok: false, error: 'Use only letters, digits, hyphens, underscores, and dots' };
  }
  return { ok: true, name: n };
}

// Build the argv for `gh repo create`. `--source .` points gh at the already
// git-initialised working directory (cwd is the repo), `--remote origin --push`
// adds the remote and pushes the initial commit. Description is only passed when
// non-empty so we don't send an empty `--description`.
function ghCreateArgs({ name, description, isPrivate }) {
  const args = ['repo', 'create', (name || '').trim(), isPrivate ? '--private' : '--public'];
  const desc = (description || '').trim();
  if (desc) args.push('--description', desc);
  args.push('--source', '.', '--remote', 'origin', '--push');
  return args;
}

module.exports = { validateRepoName, ghCreateArgs };
