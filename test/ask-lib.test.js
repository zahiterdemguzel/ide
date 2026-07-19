const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fromHook, clearsAsk, keystrokes, dismissSteps, ESC } = require('../src/main/ask-lib');

// The PreToolUse payload Claude Code actually sends for AskUserQuestion, captured from a
// live CLI. Two questions in one call, each with its own options and descriptions.
const ASK = {
  session_id: 's1',
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: {
    questions: [
      {
        question: 'Which database should the API use?',
        header: 'Database',
        options: [
          { label: 'Postgres', description: 'Full-featured relational database.' },
          { label: 'SQLite', description: 'Embedded, zero setup.' },
        ],
        multiSelect: false,
      },
      {
        question: 'Which language?',
        header: 'Language',
        options: [
          { label: 'TypeScript', description: 'Large ecosystem.' },
          { label: 'Go', description: 'Single static binary.' },
        ],
        multiSelect: false,
      },
    ],
  },
};

// A permission prompt, as PermissionRequest sends it.
const PERMISSION = {
  session_id: 's1',
  hook_event_name: 'PermissionRequest',
  tool_name: 'Write',
  cwd: '/repo',
  tool_input: { file_path: '/repo/hello.txt', content: 'hi\n' },
  permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
};

test('fromHook: reads every question, option and description off the payload', () => {
  const ask = fromHook(ASK);
  assert.equal(ask.kind, 'question');
  assert.equal(ask.questions.length, 2);
  const [db, lang] = ask.questions;
  assert.equal(db.header, 'Database');
  assert.equal(db.question, 'Which database should the API use?');
  assert.deepEqual(db.options.map((o) => [o.key, o.label]), [['1', 'Postgres'], ['2', 'SQLite']]);
  assert.equal(db.options[0].description, 'Full-featured relational database.');
  // "Type something." is the row after the last option — the one that lets the user say
  // what he actually thinks instead of picking from the list.
  assert.equal(db.customKey, '3');
  assert.equal(lang.options[1].label, 'Go');
});

test('keystrokes: an option per question, then the box\'s own Submit', () => {
  const ask = fromHook(ASK);
  // Picking an option auto-advances to the next question; after the last one the box
  // lands on its Submit tab, where "1" is "Submit answers".
  assert.deepEqual(keystrokes(ask, [{ key: '1' }, { key: '2' }]),
    [{ key: '1' }, { key: '2' }, { key: '1' }]);
});

test('dismissSteps: declining the whole box is one Esc, however many questions it holds', () => {
  // Esc cancels the box outright, so no number is ever pressed and no question can be
  // answered by accident — the tool comes back rejected and the turn goes on.
  assert.deepEqual(dismissSteps(fromHook(ASK)), [{ key: ESC }]);
  assert.deepEqual(dismissSteps(null), []);
});

test('keystrokes: a custom answer is the extra option, the words, then Enter', () => {
  const ask = fromHook(ASK);
  const steps = keystrokes(ask, [{ text: 'DuckDB please' }, { key: '1' }]);
  assert.deepEqual(steps, [
    { key: '3' }, { text: 'DuckDB please' }, { key: '\r' },
    { key: '1' },
    { key: '1' },
  ]);
});

test('keystrokes: a multiSelect question toggles each pick, then commits with Enter', () => {
  // A multiSelect question does not auto-advance: its numbers toggle rows on and off, and
  // Enter is what commits the set ("Enter to select"). The phone's card is the only client
  // that produces `keys` — the desktop answers the box at its own terminal.
  const ask = fromHook({
    ...ASK,
    tool_input: { questions: [{ ...ASK.tool_input.questions[0], multiSelect: true }] },
  });
  assert.deepEqual(keystrokes(ask, [{ keys: ['1', '2'] }]),
    [{ key: '1' }, { key: '2' }, { key: '\r' }, { key: '1' }]);
  // Options the question doesn't have are dropped, and a set of only those is no answer.
  assert.deepEqual(keystrokes(ask, [{ keys: ['2', '9'] }]),
    [{ key: '2' }, { key: '\r' }, { key: '1' }]);
  assert.deepEqual(keystrokes(ask, [{ keys: [] }]), []);
  // Words beat the toggles: a custom answer is still the "Type something." row.
  assert.deepEqual(keystrokes(ask, [{ keys: ['1'], text: 'Neither' }]),
    [{ key: '3' }, { text: 'Neither' }, { key: '\r' }, { key: '1' }]);
});

test('keystrokes: a half-answered box is not answered at all', () => {
  const ask = fromHook(ASK);
  // The submit keystroke would otherwise land on a question still waiting for an answer,
  // picking whatever option happened to be under the cursor.
  assert.deepEqual(keystrokes(ask, [{ key: '1' }]), []);
  assert.deepEqual(keystrokes(ask, []), []);
  // An option the question doesn't have is no answer either.
  assert.deepEqual(keystrokes(ask, [{ key: '9' }, { key: '1' }]), []);
});

test('fromHook: a permission prompt offers only the answers whose keystroke is knowable', () => {
  const ask = fromHook(PERMISSION);
  assert.equal(ask.kind, 'permission');
  assert.equal(ask.questions.length, 1);
  assert.match(ask.questions[0].question, /Write/);
  assert.match(ask.questions[0].question, /hello\.txt/);
  // Yes is always the box's first option, and Esc always cancels it. The "allow all
  // edits this session" row in between is numbered differently depending on what Claude
  // Code suggests for the tool — a guessed number there would GRANT what was declined.
  assert.deepEqual(ask.questions[0].options.map((o) => [o.key, o.label]),
    [['1', 'Yes'], [ESC, 'No']]);
  assert.equal(ask.questions[0].customKey, '');
  // A permission box submits on the keystroke itself; there is no Submit tab.
  assert.equal(ask.submitKey, '');
  assert.deepEqual(keystrokes(ask, [{ key: ESC }]), [{ key: ESC }]);
});

test('fromHook: AskUserQuestion fires a PermissionRequest of its own — the question wins', () => {
  // Claude Code asks permission for the ask tool itself. A bare "Allow AskUserQuestion?"
  // card must never replace the actual question.
  assert.equal(fromHook({ ...PERMISSION, tool_name: 'AskUserQuestion' }), null);
});

test('fromHook: only a question announces a question', () => {
  assert.equal(fromHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} }), null);
  assert.equal(fromHook({ hook_event_name: 'Stop' }), null);
  // A subagent's own prompts are not the session's.
  assert.equal(fromHook({ ...ASK, agent_id: 'a1' }), null);
  assert.equal(fromHook({ ...ASK, tool_input: { questions: [] } }), null);
});

test('clearsAsk: the tool ran, or the turn ended', () => {
  // PostToolUse means the prompt was allowed. A *rejected* one never runs, so it never
  // fires PostToolUse — the turn ending is what says that question is over.
  assert.equal(clearsAsk({ hook_event_name: 'PostToolUse', tool_name: 'Write' }), true);
  assert.equal(clearsAsk({ hook_event_name: 'Stop' }), true);
  assert.equal(clearsAsk({ hook_event_name: 'Notification' }), false);
  assert.equal(clearsAsk({ hook_event_name: 'PostToolUse', agent_id: 'a1' }), false);
});

test('a codex permission prompt approves with y (codex keymap), declines with Esc', () => {
  const ask = fromHook({
    hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command: 'rm -rf node_modules' },
  }, 'codex');
  assert.equal(ask.kind, 'permission');
  assert.deepEqual(ask.questions[0].options.map((o) => o.key), ['y', '\x1b']);
  // and the yes answer types exactly that key
  assert.deepEqual(keystrokes(ask, [{ key: 'y' }]), [{ key: 'y' }]);
});

test('a claude permission prompt still numbers yes as 1', () => {
  const ask = fromHook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} });
  assert.deepEqual(ask.questions[0].options.map((o) => o.key), ['1', '\x1b']);
});
