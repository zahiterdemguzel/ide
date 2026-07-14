// Pure (Electron-free) model of the question a Claude session is blocked on: what the
// card shows, and the keystrokes that answer it. Unit-tested in test/ask-lib.test.js.
//
// The question does NOT come from the terminal, and cannot. Claude Code's TUI is an Ink
// app: it paints by moving the cursor, so the bytes on the PTY have no rows or columns
// left to recover. Stripping the escapes glues a whole screen into one line with the
// gaps gone ("...❯1.Postgres" running straight into the next option's text) and drops
// characters wherever a repaint overwrote a cell. There is no regex over that.
//
// It doesn't have to come from there: every question is *announced* by a hook that
// carries it whole.
//   - Claude asking the user (the AskUserQuestion tool) fires PreToolUse, whose
//     tool_input holds every question, every option, each option's description, and
//     multiSelect. It fires before the box is even painted.
//   - a permission prompt fires PermissionRequest, naming the tool it wants to run.
//
// What the terminal is still needed for is the *answer* — the box is a real menu and
// keystrokes are the only way to work it. Those were verified against a live CLI:
//   - an option is picked by its 1-based number, and picking one AUTO-ADVANCES to the
//     next question. After the last one the box lands on a Submit tab, where "1" submits.
//   - the entry after the last real option is "Type something.": it opens a text field,
//     so a custom answer is that number, then the words, then Enter.
//   - a permission box is answered yes with "1" (always its first option) and no with
//     Esc (it prints "Esc to cancel"). Its middle options ("Yes, allow all edits this
//     session") appear only when Claude Code suggests one for that tool, so every number
//     but the first shifts. We never guess one: a number that lands on the wrong row
//     would GRANT something the user declined. Esc needs no numbering to be safe.

const { toolTitle } = require('./transcript-lib');

const ESC = '\x1b';
const ENTER = '\r';

// The tools whose whole purpose is to block on the user.
const ASK_TOOLS = new Set(['AskUserQuestion']);
const isAskTool = (name) => ASK_TOOLS.has(name);

// Claude's own multiple-choice questions, straight off the PreToolUse payload.
function questionAsk(input) {
  const raw = input && Array.isArray(input.questions) ? input.questions : [];
  const questions = raw.map((q) => {
    const options = (Array.isArray(q.options) ? q.options : [])
      .map((o, i) => ({
        key: String(i + 1),
        label: String((o && o.label) || '').trim(),
        description: String((o && o.description) || '').trim(),
      }))
      .filter((o) => o.label);
    return {
      header: String((q && q.header) || '').trim(),
      question: String((q && q.question) || '').trim(),
      multiSelect: Boolean(q && q.multiSelect),
      options,
      // "Type something." sits right after the last option. This is what keeps the user
      // from being trapped in someone else's answers — the point of a chat over a menu.
      customKey: String(options.length + 1),
    };
  }).filter((q) => q.question && q.options.length);
  return questions.length ? { kind: 'question', questions, submitKey: '1' } : null;
}

// A permission prompt. The hook names the tool but not the box's rows, so we offer only
// the two answers whose keystroke is knowable: yes, and no. An "allow all edits this
// session" shortcut is deliberately not reachable from a phone.
function permissionAsk(payload) {
  const tool = String(payload.tool_name || 'a tool');
  const what = toolTitle(tool, payload.tool_input || {}, payload.cwd || '');
  return {
    kind: 'permission',
    questions: [{
      header: tool,
      question: what ? `Allow ${tool} — ${what}?` : `Allow ${tool}?`,
      multiSelect: false,
      options: [
        { key: '1', label: 'Yes', description: '' },
        { key: ESC, label: 'No', description: '' },
      ],
      customKey: '',
    }],
    submitKey: '',
  };
}

// The ask a hook payload announces, or null if it announces none.
function fromHook(payload) {
  if (!payload || payload.agent_id) return null; // a subagent's prompts are not the session's
  const ev = payload.hook_event_name;
  const tool = payload.tool_name;
  if (ev === 'PreToolUse' && isAskTool(tool)) return questionAsk(payload.tool_input);
  // Claude Code fires PermissionRequest for AskUserQuestion too. The question itself is
  // the real card — a bare "Allow AskUserQuestion?" must never replace it.
  if (ev === 'PermissionRequest' && !isAskTool(tool)) return permissionAsk(payload);
  return null;
}

// Whether a payload means whatever was being asked is now settled. PostToolUse says the
// tool ran (so its prompt was answered); Stop ends the turn, which also covers a prompt
// that was *rejected* — the tool never runs, so no PostToolUse ever comes.
function clearsAsk(payload) {
  if (!payload || payload.agent_id) return false;
  return payload.hook_event_name === 'PostToolUse' || payload.hook_event_name === 'Stop';
}

// An answer to one question: an option's key, or words typed instead of picking one.
function answerSteps(q, answer) {
  const a = answer || {};
  const text = typeof a.text === 'string' ? a.text.trim() : '';
  if (text) return q.customKey ? [{ key: q.customKey }, { text }, { key: ENTER }] : [];
  const keys = (Array.isArray(a.keys) ? a.keys : [a.key])
    .filter((k) => q.options.some((o) => o.key === k));
  if (!keys.length) return [];
  const steps = keys.map((key) => ({ key }));
  // A multi-select question doesn't advance on its own — the numbers toggle rows, and
  // Enter is what commits them ("Enter to select").
  if (q.multiSelect) steps.push({ key: ENTER });
  return steps;
}

// The whole box, as the sequence of writes that answers it. Empty if any question is
// unanswered: a half-answered box would leave the submit keystroke landing on a menu
// that is still asking, which is worse than not answering at all.
function keystrokes(ask, answers) {
  if (!ask || !Array.isArray(ask.questions) || !ask.questions.length) return [];
  const steps = [];
  for (let i = 0; i < ask.questions.length; i += 1) {
    const one = answerSteps(ask.questions[i], (answers || [])[i]);
    if (!one.length) return [];
    steps.push(...one);
  }
  if (ask.submitKey) steps.push({ key: ask.submitKey });
  return steps;
}

module.exports = { fromHook, clearsAsk, keystrokes, isAskTool, ESC };
