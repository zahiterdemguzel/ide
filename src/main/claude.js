const { execFile, execFileSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// node-pty on Windows doesn't search PATH — resolve the full claude.exe path once.
let claudeCmd = null;
function resolveClaude() {
  if (claudeCmd) return claudeCmd;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, ['claude'], { encoding: 'utf8' });
    claudeCmd = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'claude';
  } catch { claudeCmd = 'claude'; }
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

const CREDS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const HAIKU_MODEL = 'claude-haiku-4-5-20251001';
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const OUTPUT_RULE = 'Do exactly what the user message asks and output only the '
  + 'requested text — no preamble, no explanation, no code fences, no quotes, no '
  + 'Co-Authored-By trailer.';

function readOauthToken() {
  try {
    const o = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8')).claudeAiOauth;
    if (!o || !o.accessToken) return null;
    // treat as expired a minute early to avoid racing the boundary
    if (o.expiresAt && Date.now() > o.expiresAt - 60000) return null;
    return o.accessToken;
  } catch { return null; }
}

function runApi(token, prompt) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: [{ type: 'text', text: CC_IDENTITY }, { type: 'text', text: OUTPUT_RULE }],
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return resolve(null);
        try {
          const text = JSON.parse(body).content?.[0]?.text;
          resolve(typeof text === 'string' ? text.trim() : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end(payload);
  });
}

// --- Fallback: one-shot CLI call ---------------------------------------------
// Always works (and refreshes the OAuth token on disk), just slow. Used when the
// API fast path is unavailable.
function runCli(prompt, { cwd } = {}) {
  return new Promise((resolve) => {
    const exe = resolveClaude();
    const win32 = process.platform === 'win32';
    const child = execFile(win32 ? `"${exe}"` : exe, ['-p', '--model', 'haiku'],
      { cwd, maxBuffer: 1024 * 1024, shell: win32 },
      (err, stdout) => resolve(err ? null : stdout.trim()));
    child.stdin.end(prompt);
  });
}

// One-shot Haiku generation: API fast path, CLI fallback. The full instruction
// is in `prompt` (the API uses a generic system prompt). Resolves to the trimmed
// text, or null only when both paths fail.
async function runHaiku(prompt, { cwd } = {}) {
  const token = readOauthToken();
  if (token) {
    const out = await runApi(token, prompt);
    if (out !== null) return out;
  }
  return runCli(prompt, { cwd });
}

module.exports = { resolveClaude, runHaiku };
