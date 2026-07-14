// Pure (Electron-free) reader for the question Claude's TUI is asking right now —
// the permission box ("Do you want to make this edit? 1. Yes 2. Yes, and don't ask
// again 3. No"), and any other numbered menu it draws.
//
// The phone renders the session as a chat and never shows the terminal, so a
// question drawn *in* the terminal would otherwise be invisible: the session would
// simply sit there, green and stuck. The transcript can't help — Claude records the
// tool call only once it has been allowed. So the one place the question exists is
// the PTY stream, and this lifts it out of the redrawn ANSI box.
//
// It is only ever run while the session is in `needs-input` (a hook told us so), so
// a numbered list in ordinary output — a code snippet, a `ls` — is not mistaken for
// a prompt: the session isn't waiting when that scrolls past.
//
// Unit-tested in test/tui-prompt.test.js.

// CSI/OSC/SS3 escape sequences, plus the private-mode and cursor-move noise a TUI
// repaint is made of. The control characters are the point — ESC and BEL are what
// delimits a sequence, so there is nothing to match without them.
// eslint-disable-next-line no-control-regex
const ANSI =/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[[?]?[0-9;]*[a-zA-Z]|\x1b[()][0-9A-B]|\x1b[=>ME78]/g;
// The box the TUI draws around the question, and the pointer it marks the current
// option with. None of it is content.
const BOX = /[│┃|╭╮╰╯─━┌┐└┘├┤┬┴┼█▌▐]/g;
const POINTER = /^[❯▶>»*]\s*/;

const OPTION = /^(\d{1,2})[.)]\s+(.+)$/;

function stripAnsi(s) {
  return String(s).replace(ANSI, '');
}

// The TUI repaints in place, so the stream is full of half-drawn frames. Normalizing
// each line — escapes gone, box glyphs gone, carriage returns split — leaves the
// text of every frame it ever drew, in order. The last complete frame is the one on
// screen, which is why every scan below runs from the end backwards.
function lines(tail) {
  return stripAnsi(tail)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    // Trim before stripping the pointer: the box's left edge leaves a space in
    // front of it, so an unpadded `^❯` would never match the option it marks.
    .map((l) => l.replace(BOX, ' ').trim().replace(POINTER, '').trim())
    .map((l) => l.replace(/\s{2,}/g, ' '))
    // The box's own padding rows are empty once its glyphs are gone. Dropping them
    // is what keeps a menu's options adjacent, which is how a menu is recognized.
    .filter(Boolean);
}

// Skip the hints the TUI prints under the options ("esc to interrupt", "1 for yes").
const NOISE = /^(esc|enter|tab|shift|ctrl|\/|\?|✻|·|⏵|>)/i;

// → { question, options: [{ key, label }] } for the box currently on screen, or null.
// A question with no parsable options is still a question: the caller shows it with a
// free-text reply, which is strictly better than a phone that looks idle. That is why
// `options` may come back empty rather than the whole thing coming back null.
function parseAsk(tail) {
  const ls = lines(tail);
  // Walk back to the last option list: a run of numbered lines ending at `end`.
  for (let end = ls.length - 1; end >= 0; end--) {
    if (!OPTION.test(ls[end])) continue;
    let start = end;
    while (start > 0 && OPTION.test(ls[start - 1])) start--;
    const opts = ls.slice(start, end + 1).map((l) => {
      const m = OPTION.exec(l);
      return { key: m[1], label: m[2].trim() };
    });
    // A real menu is numbered from 1 and ascends; a stray "2. foo" in output is not.
    const ordered = opts.every((o, i) => Number(o.key) === i + 1);
    if (!ordered || opts.length < 2) { end = start; continue; }
    return { question: questionAbove(ls, start), options: opts };
  }
  return null;
}

// The prompt itself: the nearest real line above the options.
function questionAbove(ls, start) {
  for (let i = start - 1; i >= 0 && i >= start - 12; i--) {
    const l = ls[i];
    if (!l || NOISE.test(l) || OPTION.test(l)) continue;
    return l.slice(0, 300);
  }
  return 'Claude needs your input';
}

module.exports = { parseAsk, stripAnsi, lines };
