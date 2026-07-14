// Debug tracing for the remote-access backend. Off unless IDE_DEBUG is set, so a
// normal run stays silent and the instrumentation below can be left in place.
//
//   IDE_DEBUG=1                every namespace
//   IDE_DEBUG=hub,relay        only those
//   IDE_DEBUG=*,-tunnel        everything except the byte-level tunnel frames
//                              (a forwarded dev server would otherwise drown the log)
//
// Namespaces: relay (cloud relay sockets/rooms), route (its head routing), tunnel
// (forwarded-port byte streams), client (desktop→relay dialer), hub (the remote
// protocol state machine), proxy (the port-forward HTTP listener), keepalive.
//
// Pure except for the default sink: everything here is a plain function over an
// env value, so what gets printed is testable without a socket.

const DEBUG_ENV = 'IDE_DEBUG';

// A field whose *name* says it is a credential is never printed, at any depth —
// pair tokens and device tokens flow through the very frames this traces.
const SECRET_KEY = /token|secret|cookie|password|authorization|_ideauth/i;
const MAX_STRING = 120;
const MAX_ITEMS = 10;

const parseScopes = (value) => String(value || '').split(/[\s,]+/).filter(Boolean);

const isWildcard = (pattern) => pattern === '*' || pattern === '1' || pattern === 'true';

// Later entries win, so `*,-tunnel` is "all but tunnel" and `-tunnel,*` is all.
function scopeEnabled(scopes, ns) {
  let on = false;
  for (const s of scopes) {
    const negated = s.startsWith('-');
    const pattern = negated ? s.slice(1) : s;
    if (isWildcard(pattern) || pattern === ns) on = !negated;
  }
  return on;
}

// Values come off the network, so they can be huge (a PTY chunk, a file's text) or
// secret. Cap them and drop the credentials; a trace is for shape, not payload.
function redact(value, key = '') {
  if (key && SECRET_KEY.test(key)) return '***';
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…+${value.length - MAX_STRING}` : value;
  }
  if (typeof value === 'function') return '[fn]';
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `<${value.length}b>`;
  if (Array.isArray(value)) {
    const head = value.slice(0, MAX_ITEMS).map((v) => redact(v));
    return value.length > MAX_ITEMS ? [...head, `…+${value.length - MAX_ITEMS}`] : head;
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return String(value);
}

// Simple strings print bare (ch=git-status); anything with a space or a quote in it
// gets quoted, so a field never runs into the next one.
const scalar = (v) => (typeof v === 'string' && /^[\w.:/@*-]*$/.test(v) ? v : JSON.stringify(v));

// A field that isn't there is not printed: callers pass one field set per message
// shape (`{t, ch, id, port}`), and most frames carry only some of them.
const formatFields = (fields) => Object.entries(redact(fields || {}))
  .filter(([, v]) => v !== undefined)
  .map(([k, v]) => `${k}=${scalar(v)}`)
  .join(' ');

function formatLine(time, ns, msg, fields) {
  const tail = formatFields(fields);
  return `${time} [${ns}] ${msg}${tail ? ` ${tail}` : ''}`;
}

const clockTime = (now) => new Date(now).toISOString().slice(11, 23);

// opts: { env, sink, now } — all injectable so tests never touch process/console/clock.
function createDebug({ env = process.env, sink = console.log, now = Date.now } = {}) {
  const scopes = parseScopes(env[DEBUG_ENV]);
  const any = scopes.length > 0;

  function debugFor(ns) {
    const on = scopeEnabled(scopes, ns);
    // `log.on` lets a caller skip building an expensive field object at all.
    const log = on
      ? (msg, fields) => sink(formatLine(clockTime(now()), ns, msg, fields))
      : () => {};
    log.on = on;
    return log;
  }

  return { debugFor, enabled: any, scopes };
}

const shared = createDebug();

module.exports = {
  DEBUG_ENV,
  parseScopes, scopeEnabled, redact, formatFields, formatLine, createDebug,
  debugFor: shared.debugFor,
  debugEnabled: shared.enabled,
};
