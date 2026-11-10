// Typing a slash command into a live TUI lands it in the same composer as whatever the
// user is half-way through writing, so the command would glue onto their draft.
// Ctrl+S is the CLI's own "stash prompt": it parks the current draft (a no-op when the
// composer is empty) and the CLI restores it by itself after the next submit, so the
// command goes through and the draft comes back without us ever reading it.
const STASH_DRAFT = '\x13';

function draftSafeSlashCommand(command) {
  return `${STASH_DRAFT}${command}\r`;
}

module.exports = { STASH_DRAFT, draftSafeSlashCommand };
