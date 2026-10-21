'use strict';

// Pure, Electron-free choice of the Claude subscription OAuth token from the
// credential blobs the CLI stores. Unit-tested in test/oauth-creds-lib.test.js.
//
// On macOS the Keychain can hold several "Claude Code-credentials" entries
// (e.g. one under account "unknown" left by an older login, one under the OS
// username). Some carry only `mcpOAuth` and no `claudeAiOauth`, so taking the
// first blob blindly hides the login. Instead, take the first candidate that
// holds an unexpired `claudeAiOauth.accessToken`.

// treat a token as expired a minute early to avoid racing the boundary
const EXPIRY_MARGIN_MS = 60000;

function tokenFromCredsJson(raw, now) {
  try {
    const oauth = JSON.parse(raw).claudeAiOauth;
    if (!oauth || !oauth.accessToken) return null;
    if (oauth.expiresAt && now > oauth.expiresAt - EXPIRY_MARGIN_MS) return null;
    return oauth.accessToken;
  } catch { return null; }
}

// rawBlobs: credential JSON strings in priority order (null/undefined skipped).
function pickOauthToken(rawBlobs, now) {
  for (const raw of rawBlobs) {
    if (!raw) continue;
    const token = tokenFromCredsJson(raw, now);
    if (token) return token;
  }
  return null;
}

module.exports = { pickOauthToken, tokenFromCredsJson };
