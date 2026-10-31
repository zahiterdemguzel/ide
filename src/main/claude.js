const { execFile, execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { usageView } = require('./usage-parse');
const { adoptLoginShellPath } = require('./shell-path');
const { pickOauthToken, pickOauthCreds } = require('./oauth-creds-lib');
const { withFolderTrusted } = require('./claude-trust-lib');
const { keychainServiceFor, credentialsPathFor, claudeJsonPathFor, accountEnv } = require('./accounts-lib');
const { MODEL_ORDER, requestExtrasFor, isModelRejection } = require('./ai-assist-lib');

// node-pty on Windows doesn't search PATH — resolve the full claude.exe path once.
// Async (the `where`/`which` subprocess used to run execFileSync and block the
// main process — every IPC reply and PTY byte stalls while main is blocked).
let claudeCmd = null;
function resolveClaude() {
  if (claudeCmd) return claudeCmd;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  // Dock/Finder launches start without the user's PATH (no ~/.local/bin, where the
  // native installer puts `claude`), so adopt the login shell's PATH first.
  claudeCmd = adoptLoginShellPath().then(() => new Promise((resolve) => {
    execFile(finder, ['claude'], { encoding: 'utf8' }, (err, stdout) => {
      const found = !err && stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      resolve(found || 'claude');
    });
  }));
  return claudeCmd;
}

// --- Fast path: direct Messages API call with the CLI's OAuth token ----------
// `claude -p` cold-starts the whole CLI (Node + plugins + hooks + MCP) and sends
// its full agentic system prompt + tool defs every call — ~5s for a one-line
// commit message. Instead we call the Messages API directly with the OAuth token
// Claude Code already stored (`~/.claude/.credentials.json`), with a one-line
// system prompt and no tools: ~1s, no process boot.
//
// Subscription (OAuth) tokens are only accepted when the first system block is
// the Claude Code identity string — same one the CLI sends. The token is
// short-lived; when it's missing/expired or the call fails for any reason we
// return null and the caller falls back to the CLI, which also refreshes the
// stored token, so the fast path heals itself on the next call.

const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OUTPUT_RULE = 'Do exactly what the user message asks and output only the '
  + 'requested text — no preamble, no explanation, no code fences, no quotes, no '
  + 'Co-Authored-By trailer.';

// The CLI stores its OAuth credentials in one of two places depending on the OS:
// a `~/.claude/.credentials.json` file on Linux/Windows, but the *macOS Keychain*
// (generic password, service "Claude Code-credentials") on darwin — there is no
// file there. Read the file first (cheap, and present if the user opted out of
// the Keychain), then fall back to the Keychain on macOS. Either way we get the
// same `{ claudeAiOauth: { accessToken, expiresAt, … } }` JSON blob.
// With several accounts (accounts.js), each extra one is its own CLAUDE_CONFIG_DIR
// with its own credentials file and Keychain service; `configDir` null is the
// default account. Callers that don't name one get the active account.
function readKeychainCreds(service, account) {
  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.splice(3, 0, '-a', account);
  // stderr ignored: a miss (an account never signed in) is expected, not news.
  try { return execFileSync('security', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// Lazily yields candidate credential blobs in priority order, so the common
// case (file, or the current user's Keychain entry) spawns at most one process.
function* credsCandidates(configDir) {
  try { yield fs.readFileSync(credentialsPathFor(configDir, os.homedir()), 'utf8'); } catch {}
  if (process.platform !== 'darwin') return;
  const service = keychainServiceFor(configDir);
  // The CLI writes under the OS username; a stale entry (often account
  // "unknown") with no claudeAiOauth can sort first, so ask for ours first.
  yield readKeychainCreds(service, os.userInfo().username);
  yield readKeychainCreds(service, null);
}

// Required lazily: accounts.js needs Electron and itself requires this file.
function activeConfigDir() {
  try { return require('./accounts').activeAccount().configDir; } catch { return null; }
}

function readOauthToken(configDir = activeConfigDir()) {
  return pickOauthToken(credsCandidates(configDir), Date.now());
}

// The account's stored login, expired or not (see pickOauthCreds), or null.
function readOauthCreds(configDir = activeConfigDir()) {
  return pickOauthCreds(credsCandidates(configDir), Date.now());
}

// readOauthCreds without blocking the main process on the Keychain, for the
// account proxy, which reads logins while sessions are streaming.
function readKeychainCredsAsync(service, account) {
  const args = ['find-generic-password', '-s', service, '-w'];
  if (account) args.splice(3, 0, '-a', account);
  return new Promise((resolve) => {
    execFile('security', args, { encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function readOauthCredsAsync(configDir = activeConfigDir()) {
  const blobs = [];
  try { blobs.push(fs.readFileSync(credentialsPathFor(configDir, os.homedir()), 'utf8')); } catch {}
  if (process.platform !== 'darwin') return pickOauthCreds(blobs, Date.now());
  const service = keychainServiceFor(configDir);
  blobs.push(await readKeychainCredsAsync(service, os.userInfo().username));
  const found = pickOauthCreds(blobs, Date.now());
  if (found && !found.expired) return found;
  blobs.push(await readKeychainCredsAsync(service, null));
  return pickOauthCreds(blobs, Date.now());
}

const MESSAGES_URL = 'https://api.anthropic.com/v1/messages';

// Headers every OAuth Messages API call needs (the oauth beta flag is what makes
// a subscription token acceptable in place of an API key).
function oauthHeaders(token, payload) {
  return {
    authorization: `Bearer ${token}`,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'oauth-2025-04-20',
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  };
}

// Normalise the API's `{ type: 'error', error: { type, message } }` body (or a
// non-JSON body) into the failure shape callMessages resolves with.
function apiFailure(status, body) {
  let errorType = null;
  let message = '';
  try {
    const parsed = JSON.parse(body);
    errorType = parsed?.error?.type || null;
    message = parsed?.error?.message || '';
  } catch { message = String(body || '').slice(0, 300); }
  return { ok: false, status, errorType, message };
}

// Feed raw SSE bytes in; get each complete event's parsed `data:` JSON out.
// Events are separated by a blank line; only the data lines matter here — every
// Messages API event also carries its type inside the JSON.
function createSseParser(onEvent) {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
      const data = rawEvent.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try { onEvent(JSON.parse(data)); } catch {}
    }
  };
}

// General Messages API call with the Claude Code OAuth token. The CC identity is
// always sent as the first system block (OAuth tokens are refused without it);
// `system` (a string or an array of strings) follows it. `extra` merges further
// request fields (e.g. a per-model `thinking` setting). With `stream`, text
// deltas are passed to `onText` as they arrive. `signal` (an AbortSignal)
// cancels the request. Never rejects; resolves to
//   { ok: true, text, stopReason }  or
//   { ok: false, status, errorType, message, aborted? }
// where `text` is the untrimmed concatenation of all text blocks.
function callMessages({
  token = readOauthToken(), model = HAIKU_MODEL, system = [], messages,
  maxTokens = 1024, stopSequences, stream = false, onText, signal, extra = {},
}) {
  if (!token) return Promise.resolve({ ok: false, status: 0, errorType: 'no_token', message: 'No Claude Code OAuth token' });
  if (signal?.aborted) return Promise.resolve({ ok: false, status: 0, errorType: 'aborted', message: 'Aborted', aborted: true });
  const extraSystem = (Array.isArray(system) ? system : [system]).filter(Boolean);
  const payload = JSON.stringify({
    model,
    max_tokens: maxTokens,
    system: [CC_IDENTITY, ...extraSystem].map((text) => ({ type: 'text', text })),
    messages,
    ...(stopSequences?.length ? { stop_sequences: stopSequences } : {}),
    ...(stream ? { stream: true } : {}),
    ...extra,
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const req = https.request(MESSAGES_URL, { method: 'POST', headers: oauthHeaders(token, payload) }, (res) => {
      res.setEncoding('utf8');
      if (res.statusCode !== 200) {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => finish(apiFailure(res.statusCode, body)));
        return;
      }
      if (!stream) {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            const text = (parsed.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
            finish({ ok: true, text, stopReason: parsed.stop_reason || null });
          } catch { finish(apiFailure(res.statusCode, body)); }
        });
        return;
      }
      let text = '';
      let stopReason = null;
      let streamError = null;
      const feed = createSseParser((event) => {
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          text += event.delta.text;
          if (onText) { try { onText(event.delta.text); } catch {} }
        } else if (event.type === 'message_delta' && event.delta?.stop_reason) {
          stopReason = event.delta.stop_reason;
        } else if (event.type === 'error') {
          streamError = event.error || { type: 'stream_error', message: 'Stream error' };
        }
      });
      res.on('data', feed);
      res.on('end', () => finish(streamError
        ? { ok: false, status: 200, errorType: streamError.type, message: streamError.message || '' }
        : { ok: true, text, stopReason }));
      res.on('error', (err) => finish({ ok: false, status: 0, errorType: 'network', message: err.message }));
    });
    function onAbort() {
      req.destroy();
      finish({ ok: false, status: 0, errorType: 'aborted', message: 'Aborted', aborted: true });
    }
    signal?.addEventListener('abort', onAbort);
    req.on('error', (err) => finish({ ok: false, status: 0, errorType: 'network', message: err.message }));
    req.end(payload);
  });
}

// Haiku one-shot over the fast path: trimmed text, or null on any failure.
// Short generations (commit messages, titles) use the cheapest model with
// thinking off: Haiku 5.5 first, Haiku 4.5 only if the API rejects 5.5. The id
// that works is memoised so the fallback costs one round-trip per app run.
let shortGenModel = null;
async function runApi(token, prompt) {
  const candidates = shortGenModel ? [shortGenModel] : MODEL_ORDER.complete;
  for (const model of candidates) {
    const result = await callMessages({
      token, model, system: OUTPUT_RULE, maxTokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      extra: requestExtrasFor(model),
    });
    if (result.ok) {
      shortGenModel = model;
      return result.text.trim();
    }
    if (!isModelRejection(result)) return null;
  }
  return null;
}

// --- Fallback: one-shot CLI call ---------------------------------------------
// Always works (and refreshes the OAuth token on disk), just slow. Used when the
// API fast path is unavailable.
//
// The flags matter as much as the model. A bare `claude -p` boots a full agentic
// session and bills its whole preamble — every built-in tool definition, the
// repo's CLAUDE.md, its MCP server defs, its skill list — on every commit
// message. This path only ever asks Haiku for one turn over a diff, so we
// replace the system prompt, drop the tools, and run from a neutral cwd so no
// project context is discovered. (`--bare` would do this in one flag, but it
// refuses the OAuth token that this fallback exists to refresh.)
function leanArgs(model, systemPrompt) {
  return [
    '-p', '--model', model,
    '--system-prompt', systemPrompt,
    '--tools', '',
    '--strict-mcp-config',
    '--disable-slash-commands',
  ];
}
const DEFAULT_CLI_SYSTEM = `${CC_IDENTITY} ${OUTPUT_RULE}`;

// `model` and `systemPrompt` default to the Haiku one-shot setup; the inline
// edit fallback passes `sonnet` and its own system prompt. The system prompt
// must not contain a double quote (see the Windows quoting note below).
// `signal` (an AbortSignal) kills the child; it then resolves null.
async function runCli(prompt, { model = 'haiku', systemPrompt = DEFAULT_CLI_SYSTEM, signal, configDir = activeConfigDir() } = {}) {
  const exe = await resolveClaude();
  if (signal?.aborted) return null;
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    const args = leanArgs(model, systemPrompt);
    // Windows needs `shell` to launch the `claude.cmd` shim, and the shell
    // re-splits argv — so quote each argument there, including the empty
    // `--tools` value, which would otherwise be dropped instead of disabling
    // the tools. None of the args contains a double quote, so wrapping is enough.
    const quotedArgs = win32 ? args.map((a) => `"${a}"`) : args;
    const child = execFile(win32 ? `"${exe}"` : exe, quotedArgs,
      // Run as the active account (unless told otherwise), so a fallback call bills
      // the same login the sessions use.
      { cwd: os.tmpdir(), maxBuffer: 4 * 1024 * 1024, shell: win32, // MAX_THINKING_TOKENS=0 turns extended thinking off: these are short one-shot generations.
      env: { ...process.env, ...accountEnv({ configDir }), MAX_THINKING_TOKENS: '0' } },
      (err, stdout) => {
        signal?.removeEventListener('abort', kill);
        resolve(err ? null : stdout.trim());
      });
    function kill() { child.kill(); }
    signal?.addEventListener('abort', kill);
    child.stdin.end(prompt);
  });
}

// Detect whether the Claude Code CLI is installed and runnable. The app drives a
// first-run setup gate off this: a user without Claude Code is guided to install
// it before they can open a session (see src/renderer/claude-setup.js). We run
// `claude --version` — fast (no agentic boot) and the truest test of "actually
// usable", since a stale PATH entry that no longer launches still counts as
// missing. Any failure (not on PATH, non-zero exit, timeout) resolves to
// not-installed. `resolveClaude()` is intentionally re-run (cache cleared) so a
// re-check after a fresh install can pick the binary up.
async function claudeAvailable() {
  claudeCmd = null; // re-probe PATH: the user may have just installed it
  const exe = await resolveClaude();
  return new Promise((resolve) => {
    const win32 = process.platform === 'win32';
    execFile(win32 ? `"${exe}"` : exe, ['--version'],
      { timeout: 10000, shell: win32 },
      (err, stdout) => {
        // A binary that exists but was slow to answer (first run after an auto-update,
        // while macOS verifies its signature) is installed, not missing.
        if (err) return resolve({ installed: !!err.killed && path.isAbsolute(exe) && fs.existsSync(exe), version: null });
        resolve({ installed: true, version: (stdout || '').trim() || null });
      });
  });
}

// One-shot Haiku generation: API fast path, CLI fallback. The full instruction
// is in `prompt` — both paths send it as the only user message, under the same
// one-line system prompt and with no tools or project context, so a caller never
// pays for more than the text it passed in. Resolves to the trimmed text, or
// null only when both paths fail.
async function runHaiku(prompt) {
  const token = readOauthToken();
  if (token) {
    const out = await runApi(token, prompt);
    if (out !== null) return out;
  }
  return runCli(prompt);
}

// --- Subscription usage (toolbar meter) --------------------------------------
// The user's remaining Claude usage isn't exposed by any CLI command or a
// dedicated endpoint — it rides on the *unified rate-limit response headers* of a
// real /v1/messages call (count_tokens returns none; verified live). So we make
// the smallest possible call (max_tokens: 1 ≈ one output token) once a minute and
// read the 5h + weekly windows off the headers. OAuth tokens only answer when the
// first system block is the Claude Code identity string — same gate as runApi.
//
// The rate-limit headers ride on the 429 you get once you're out of usage too, so
// we parse them regardless of status code — that's exactly when the meter matters
// most. usageView returns null when the headers are absent (a bad/expired token or
// a transport error), so a non-usage failure still hides the meter.
function fetchUsage(token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1,
      system: [{ type: 'text', text: CC_IDENTITY }],
      messages: [{ role: 'user', content: '.' }],
    });
    const req = https.request(MESSAGES_URL, { method: 'POST', headers: oauthHeaders(token, payload) }, (res) => {
      res.on('data', () => {}); // drain so the socket can be reused/closed
      res.on('end', () => resolve(usageView(res.headers, Date.now())));
    });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

// Whether the API accepts `token`: resolves to the HTTP status of the same 1-token
// call the usage meter makes (401 = the login is no longer valid), or 0 when the
// API couldn't be reached at all — offline says nothing about the login.
function probeOauthToken(token) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1,
      system: [{ type: 'text', text: CC_IDENTITY }],
      messages: [{ role: 'user', content: '.' }],
    });
    const req = https.request(MESSAGES_URL, { method: 'POST', headers: oauthHeaders(token, payload), timeout: 15000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode || 0));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(0));
    req.end(payload);
  });
}

// Returns the usage view model ({ windows: [...] }) or null when there is no
// usable OAuth token or the call fails — the renderer hides the meter on null.
// `configDir` picks the account (default: the active one).
async function readUsage(configDir = activeConfigDir()) {
  const token = readOauthToken(configDir);
  return token ? fetchUsage(token) : null;
}

// Pre-accept Claude Code's folder-trust dialog for `dir` (see claude-trust-lib.js).
// Best effort: an unreadable or unparsable config is left alone rather than
// replaced, and the session then just shows the dialog as before. Written via a
// temp file + rename so a concurrently starting `claude` never reads half a file.
// `accountConfigDir` is the account the session spawns as (null: the default one,
// which still honours a CLAUDE_CONFIG_DIR the app itself was launched with).
function ensureFolderTrusted(dir, accountConfigDir = null) {
  if (!dir) return;
  const configPath = accountConfigDir
    ? claudeJsonPathFor(accountConfigDir, os.homedir())
    : path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  try {
    let config = {};
    if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const next = withFolderTrusted(config, dir);
    if (!next) return;
    const tmpPath = `${configPath}.ide-${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2));
    fs.renameSync(tmpPath, configPath);
  } catch (err) {
    console.warn('[claude] could not pre-trust folder:', err.message);
  }
}

module.exports = {
  resolveClaude, ensureFolderTrusted, runHaiku, claudeAvailable, readUsage,
  // General-purpose access for other features (inline AI assist in the editor).
  callMessages, runCli, readOauthToken, readOauthCreds, readOauthCredsAsync, probeOauthToken, activeConfigDir, HAIKU_MODEL, CC_IDENTITY,
};
