// What every PTY we spawn tells its child about the terminal it is drawing into.
//
// Spinners, progress bars and full-screen TUIs (npm, pnpm, yarn, cargo, docker…)
// pick their output from these variables. The old `TERM=xterm-color` terminfo
// advertises only 8 colors and a reduced capability set, so many tools fell back
// to degraded or broken output. A GUI app launched from Finder/Dock also gets no
// LANG at all, which makes tools assume ASCII and drop Unicode spinner glyphs (or
// zsh print them as <e2><a0>…). xterm.js really is an xterm-256color terminal with
// 24-bit color, so say exactly that.
//
// Pure (takes/returns an env object), so it's unit-tested (test/terminal-env.test.js).

const PTY_TERM_NAME = 'xterm-256color';
const FALLBACK_UTF8_LOCALE = 'en_US.UTF-8';

// Variables a parent terminal (iTerm, Terminal.app, VS Code) leaves behind when the
// app is started from it. Tools read them to emit that emulator's private escapes
// (inline images, shell integration marks), which xterm.js would print as junk.
const INHERITED_EMULATOR_VARS = [
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TERM_SESSION_ID',
  'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'ITERM_SESSION_ID', 'ITERM_PROFILE',
  'VTE_VERSION', 'WT_SESSION', 'WT_PROFILE_ID', 'KITTY_WINDOW_ID', 'ALACRITTY_WINDOW_ID',
];

const isUtf8 = (value) => /utf-?8/i.test(value || '');

// The locale category that decides character encoding: LC_ALL beats LC_CTYPE beats LANG.
function effectiveCtype(env) {
  return env.LC_ALL || env.LC_CTYPE || env.LANG || '';
}

function terminalEnv(baseEnv, platform = process.platform) {
  const env = { ...baseEnv };
  for (const name of INHERITED_EMULATOR_VARS) delete env[name];
  env.TERM = PTY_TERM_NAME;
  env.COLORTERM = 'truecolor';
  // Windows' ConPTY is always UTF-16/UTF-8 and ignores POSIX locales.
  if (platform !== 'win32' && !isUtf8(effectiveCtype(env))) {
    // An explicit non-UTF-8 LC_ALL is a deliberate user choice; leave it alone.
    if (!env.LC_ALL) {
      if (!env.LANG) env.LANG = FALLBACK_UTF8_LOCALE;
      else env.LC_CTYPE = FALLBACK_UTF8_LOCALE;
    }
  }
  return env;
}

module.exports = { terminalEnv, PTY_TERM_NAME };
