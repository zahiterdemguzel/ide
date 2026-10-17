import { test } from 'node:test';
import assert from 'node:assert/strict';
import lib from '../src/main/ai-assist-lib.js';

const {
  MODEL_ORDER, requestExtrasFor, isModelRejection, prefixWindow, suffixWindow,
  shouldSkipCompletion, buildCompletionPrompt, buildEditPrompt, extractTagged, stripFences,
  stripPreamble, trimPrefixOverlap, trimSuffixOverlap, capLines, commonIndent, reindent,
  cleanCompletion, cleanEdit,
} = lib;

test('MODEL_ORDER: newest model first, Haiku 4.5 as the last resort for both roles', () => {
  assert.equal(MODEL_ORDER.complete[0], 'claude-haiku-5-5');
  assert.equal(MODEL_ORDER.edit[0], 'claude-sonnet-5-5');
  assert.equal(MODEL_ORDER.complete.at(-1), 'claude-haiku-4-5-20251001');
  assert.equal(MODEL_ORDER.edit.at(-1), 'claude-haiku-4-5-20251001');
});

test('requestExtrasFor: turns thinking off the way each 5.5 model accepts', () => {
  assert.deepEqual(requestExtrasFor('claude-haiku-5-5'), { thinking: { type: 'disabled' } });
  assert.deepEqual(requestExtrasFor('claude-sonnet-5-5'), { thinking: { type: 'between_tools' } });
  assert.deepEqual(requestExtrasFor('claude-haiku-4-5-20251001'), {});
});

test('isModelRejection: only 400/404 fall through to the next model', () => {
  assert.equal(isModelRejection({ ok: false, status: 404, errorType: 'not_found_error' }), true);
  assert.equal(isModelRejection({ ok: false, status: 400, errorType: 'invalid_request_error' }), true);
  assert.equal(isModelRejection({ ok: false, status: 401 }), false);
  assert.equal(isModelRejection({ ok: false, status: 429 }), false);
  assert.equal(isModelRejection({ ok: false, status: 0, aborted: true }), false);
  assert.equal(isModelRejection({ ok: true }), false);
});

test('prefixWindow / suffixWindow: cap length and prefer line boundaries', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const before = prefixWindow(lines, 50);
  assert.ok(before.length <= 50);
  assert.ok(before.startsWith('line'), 'starts at a line boundary');
  assert.ok(lines.endsWith(before));
  const after = suffixWindow(lines, 50);
  assert.ok(after.length <= 50);
  assert.ok(lines.startsWith(after));
  assert.ok(!after.endsWith('\n'));
  assert.equal(prefixWindow('short'), 'short');
  assert.equal(suffixWindow(''), '');
});

test('shouldSkipCompletion: skips mid-identifier, not after a word or before punctuation', () => {
  assert.equal(shouldSkipCompletion({ prefix: 'const fo', suffix: 'o = 1' }), true);
  assert.equal(shouldSkipCompletion({ prefix: 'const foo', suffix: ' = 1' }), false);
  assert.equal(shouldSkipCompletion({ prefix: 'print(', suffix: ')' }), false);
  assert.equal(shouldSkipCompletion({ prefix: '', suffix: '' }), false);
});

test('buildCompletionPrompt: marks the cursor between prefix and suffix and stops at </fill>', () => {
  const p = buildCompletionPrompt({
    language: 'javascript', path: 'src/a.js', prefix: 'function f() {\n  ', suffix: '\n}',
    snippets: [{ path: 'src/b.js', text: 'export const B = 1;' }],
  });
  assert.match(p.user, /src\/a\.js \(javascript\)/);
  assert.ok(p.user.includes('function f() {\n  <|CURSOR|>\n}'));
  assert.ok(p.user.includes('<snippet path="src/b.js">'));
  assert.deepEqual(p.stopSequences, ['</fill>']);
  assert.match(p.system, /only the text to insert/);
});

test('buildEditPrompt: selection mode vs generate mode vs follow-up refinement', () => {
  const edit = buildEditPrompt({ language: 'python', path: 'a.py', instruction: 'add types',
    selection: 'def f(x):\n    return x', prefix: 'import os\n', suffix: '\n' });
  assert.ok(edit.user.includes('<selection>\ndef f(x):\n    return x\n</selection>'));
  assert.ok(edit.user.includes('Instruction: add types'));
  assert.deepEqual(edit.stopSequences, ['</replacement>']);

  const gen = buildEditPrompt({ language: 'python', path: 'a.py', instruction: 'a main guard',
    selection: '', prefix: 'import os\n', suffix: '' });
  assert.ok(gen.user.includes('import os\n<|CURSOR|>'));
  assert.ok(!gen.user.includes('<selection>'));
  assert.notEqual(gen.system, edit.system);

  const refine = buildEditPrompt({ language: 'python', path: 'a.py', instruction: 'shorter',
    selection: 'x = 1', prefix: '', suffix: '', previous: 'x: int = 1' });
  assert.ok(refine.user.includes('<proposal>\nx: int = 1\n</proposal>'));
  assert.ok(refine.user.includes('follow-up instruction: shorter'));
});

test('extractTagged: tolerates a swallowed closing tag and missing tags', () => {
  assert.equal(extractTagged('<fill>abc</fill>', 'fill'), 'abc');
  assert.equal(extractTagged('<fill>abc', 'fill'), 'abc');
  assert.equal(extractTagged('abc', 'fill'), 'abc');
  assert.equal(extractTagged('<replacement>\ncode\n</replacement>', 'replacement'), 'code');
  assert.equal(extractTagged('<fill>\n  x', 'fill', { trimFormatting: false }), '\n  x');
});

test('stripFences / stripPreamble: unwrap markdown and chatter', () => {
  assert.equal(stripFences('```js\nconst a = 1;\n```'), 'const a = 1;');
  assert.equal(stripFences('Here is the code:\n```\nx\n```'), 'x');
  assert.equal(stripFences('plain'), 'plain');
  assert.equal(stripPreamble('Here is the updated code:\nfoo()'), 'foo()');
  assert.equal(stripPreamble('foo()\nbar()'), 'foo()\nbar()');
});

test('trimPrefixOverlap: drops a repeat of the typed line or a long prefix tail', () => {
  assert.equal(trimPrefixOverlap('const total = a + b;', 'x\n  const total = '), 'a + b;');
  assert.equal(trimPrefixOverlap('return value;\n  next();', 'if (x) {\n  return value;\n'), '  next();');
  assert.equal(trimPrefixOverlap('a + b', 'const x = '), 'a + b');
});

test('trimSuffixOverlap: removes duplicated closers only when they unbalance the text', () => {
  // f(|) -> "a, b)" would leave "f(a, b))"
  assert.equal(trimSuffixOverlap('a, b)', ')'), 'a, b');
  // print(|) -> "foo()" is balanced and correct as-is
  assert.equal(trimSuffixOverlap('foo()', ')'), 'foo()');
  // duplicated closing brace line
  assert.equal(trimSuffixOverlap('  return 1;\n}', '\n}\n'), '  return 1;');
  // long verbatim overlap is trimmed regardless of brackets
  assert.equal(trimSuffixOverlap('x = 1\nprint(x)', '\nprint(x)\n'), 'x = 1');
});

test('capLines: cuts at a blank line within the limit, else hard', () => {
  const text = 'a\nb\n\nc\nd\ne';
  assert.equal(capLines(text, 4), 'a\nb');
  assert.equal(capLines('1\n2\n3\n4\n5', 3), '1\n2\n3');
  assert.equal(capLines('1\n2', 3), '1\n2');
});

test('cleanCompletion: end-to-end cleanup of typical model replies', () => {
  const ctx = { prefix: 'function fib(n) {\n  if (n < 2) return n;\n  ', suffix: '\n}\n' };
  assert.equal(cleanCompletion('<fill>return fib(n - 1) + fib(n - 2);</fill>', ctx), 'return fib(n - 1) + fib(n - 2);');
  assert.equal(cleanCompletion('<fill>```js\nreturn 1;\n```', ctx), 'return 1;');
  // the indent already typed is not repeated
  assert.equal(cleanCompletion('<fill>  return 1;', ctx), 'return 1;');
  // duplicated closing brace from the suffix is dropped
  assert.equal(cleanCompletion('<fill>return 1;\n}', ctx), 'return 1;');
  // empty / junk
  assert.equal(cleanCompletion('<fill></fill>', ctx), '');
  assert.equal(cleanCompletion("I'm sorry, I can't help with that", ctx), '');
  assert.equal(cleanCompletion('<fill>   \n  ', ctx), '');
});

test('cleanCompletion: stays on one line when text follows the cursor on that line', () => {
  const out = cleanCompletion('<fill>a, b\nmore()', { prefix: 'f(', suffix: ')\nnext' });
  assert.equal(out, 'a, b');
});

test('cleanCompletion: a completion after `{` may start with a newline; long ones are capped', () => {
  const out = cleanCompletion('<fill>\n  return 1;', { prefix: 'function f() {', suffix: '' });
  assert.equal(out, '\n  return 1;');
  const long = Array.from({ length: 30 }, (_, i) => `x${i}();`).join('\n');
  assert.equal(cleanCompletion(`<fill>${long}`, { prefix: '', suffix: '', maxLines: 5 }).split('\n').length, 5);
});

test('cleanCompletion: returns nothing when the suggestion is what already follows', () => {
  assert.equal(cleanCompletion('<fill>)', { prefix: 'f(x', suffix: ')' }), '');
});

test('commonIndent / reindent: shift a block to the base indent, keeping relative nesting', () => {
  assert.equal(commonIndent('    a\n      b\n\n    c'), '    ');
  assert.equal(reindent('if x:\n    y', '    '), '    if x:\n        y');
  assert.equal(reindent('        a\n          b', '  '), '  a\n    b');
  assert.equal(reindent('  a\n\n  b', '  '), '  a\n\n  b');
});

test('cleanEdit: unwraps the tag, repairs indentation, flags junk', () => {
  assert.equal(cleanEdit('<replacement>\nfoo()\nbar()\n</replacement>', { baseIndent: '    ' }), '    foo()\n    bar()');
  assert.equal(cleanEdit('<replacement>\n```python\ndef f():\n    pass\n```', { baseIndent: '' }), 'def f():\n    pass');
  // empty replacement is a valid (deletion) answer when the model used the tag
  assert.equal(cleanEdit('<replacement></replacement>'), '');
  // prose without the tag is junk
  assert.equal(cleanEdit("I'm sorry, I can't do that."), null);
  assert.equal(cleanEdit(''), null);
  // null baseIndent keeps the model's own indentation
  assert.equal(cleanEdit('<replacement>\n    x = 1\n', { baseIndent: null }), '    x = 1');
  // leading blank lines and trailing whitespace are dropped
  assert.equal(cleanEdit('<replacement>\n\n\nx\n\n', { baseIndent: '' }), 'x');
});
