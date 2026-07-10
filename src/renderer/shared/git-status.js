console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval shared/git-status.js'); // PERF-TEMP
// Human-readable description of one status row, shown as the git pane's status
// badge tooltip. The same porcelain letter means different things in the staged
// vs unstaged column — most confusingly 'D': a *staged* deletion (file removed
// from the index and gone on disk) vs a file *deleted on disk but not staged*.
// Unstaging the former with "−" doesn't clear it: `git reset` restores the
// file's index entry but leaves it missing on disk, so git re-reports it as an
// unstaged deletion and the same red "D" just hops to the Changes list. The
// label spells out which side a row is on, and for an unstaged deletion points
// at Discard — the action that actually brings the file back.
const STATUS_WORD = { M: 'modification', A: 'new file', D: 'deletion', R: 'rename', C: 'copy', T: 'type change' };

export function statusLabel(status, staged) {
  if (status === '?') return 'Untracked — not staged';
  const word = STATUS_WORD[status] || `“${status}” change`;
  if (staged) return `Staged ${word}`;
  if (status === 'D') return 'Deleted on disk — not staged (use Discard to restore the file)';
  return `Unstaged ${word}`;
}

// Git branch names can't contain spaces, so when the user types a name with
// spaces in the create-branch box we silently turn each run of spaces into a
// single hyphen (and trim leading/trailing space) rather than rejecting it.
export function normalizeBranchName(name) {
  return (name || '').trim().replace(/\s+/g, '-');
}
