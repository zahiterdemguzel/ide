// Pure (Electron-free) formatting for crash logs; the fs/path/Electron glue lives
// in crashlog.js. Kept here so the naming + body format stay unit-testable.

// A filesystem-safe, sortable log filename from a timestamp: `crash-<iso>.log`
// with the ':' and '.' Windows forbids in filenames replaced by '-'.
function crashLogName(when = new Date()) {
  return 'crash-' + when.toISOString().replace(/[:.]/g, '-') + '.log';
}

// The log body: a header (what crashed + when) followed by the error's stack, or
// its string form when there is no stack.
function formatCrash(kind, err, when = new Date()) {
  const detail = err && err.stack ? err.stack : String(err);
  return [`=== ${kind} ===`, `Time: ${when.toISOString()}`, '', detail, ''].join('\n');
}

module.exports = { crashLogName, formatCrash };
