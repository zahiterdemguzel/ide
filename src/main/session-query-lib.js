// Paged, searchable queries over the session list — what `query-sessions` serves.
// A client with a long archive (a phone especially) should not have to hold every
// session just to show a screenful, so the tab filter, the search, the newest-first
// ordering and the slicing all happen here and only one page goes over the wire.
//
// Matching mirrors the desktop's Archived-tab search (renderer/shared/name-match.js,
// itself mirroring explorer's `search-names`): the query is folded (NFC +
// case-insensitive) and split on whitespace into terms that ALL must match. A term
// of "*.png" or ".png" matches by suffix; any other term is a plain substring.
// Electron-free so it's unit-tested on its own.

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 200;

const fold = (s) => String(s == null ? '' : s).normalize('NFC').toLowerCase();

function compileQuery(q) {
  const needle = fold(String(q == null ? '' : q).trim());
  if (!needle) return [];
  return needle.split(/\s+/).map((t) => {
    const ext = /^\*?\.([a-z0-9]+)$/.exec(t);
    return ext ? { suffix: '.' + ext[1] } : { sub: t };
  });
}

function matchesTerms(terms, haystack) {
  const hay = fold(haystack);
  return terms.every((t) => (t.suffix ? hay.endsWith(t.suffix) : hay.includes(t.sub)));
}

// A session's searchable text: its generated title plus its first prompt — the same
// identity a row shows, so a query matches what the user actually reads.
function sessionHaystack(s) {
  return `${s.name || ''} ${s.firstPrompt || ''}`;
}

function inTab(s, tab) {
  if (tab === 'all') return true;
  if (tab === 'archived') return !!s.archived;
  return !s.archived;
}

// `rows` is the full session set for the open project, in creation order.
// Returns one page plus the counts every tab chip needs, so a client never has to
// hold the whole set to render its list. `total` is the size of the *filtered* tab
// (what the page is drawn from); `counts` are the unfiltered per-tab totals.
function querySessions(rows, opts = {}) {
  const tab = opts.tab === 'archived' || opts.tab === 'all' ? opts.tab : 'active';
  const offset = Math.max(0, Math.trunc(Number(opts.offset)) || 0);
  const rawLimit = Math.trunc(Number(opts.limit)) || DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));

  const counts = { active: 0, archived: 0, all: rows.length };
  for (const s of rows) {
    if (s.archived) counts.archived++;
    else counts.active++;
  }

  const terms = compileQuery(opts.query);
  const matched = rows.filter(
    (s) => inTab(s, tab) && (terms.length === 0 || matchesTerms(terms, sessionHaystack(s))),
  );
  // Sessions arrive in creation order; the newest belongs on top of every tab.
  matched.reverse();

  return { items: matched.slice(offset, offset + limit), total: matched.length, counts };
}

module.exports = { compileQuery, matchesTerms, sessionHaystack, querySessions, DEFAULT_LIMIT, MAX_LIMIT };
