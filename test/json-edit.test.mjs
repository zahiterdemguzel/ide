import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonInsertion } from '../src/renderer/shared/json-edit.js';

// Apply an insertion to the source text and return the result + selected text.
function apply(text, ins) {
  const out = text.slice(0, ins.at) + ins.insert + text.slice(ins.at);
  return { out, sel: out.slice(ins.selStart, ins.selEnd) };
}

test('jsonInsertion: null outside any container', () => {
  assert.equal(jsonInsertion('{"a": 1}', 0), null);
  assert.equal(jsonInsertion('  {"a": 1}', 1), null);
  assert.equal(jsonInsertion('plain text', 4), null);
});

test('jsonInsertion: null in an unclosed container', () => {
  assert.equal(jsonInsertion('{"a": [1, 2', 8), null);
});

test('jsonInsertion: empty inline object', () => {
  const text = '{}';
  const ins = jsonInsertion(text, 1);
  assert.equal(ins.type, 'object');
  const { out, sel } = apply(text, ins);
  assert.equal(out, '{"key": ""}');
  assert.equal(sel, 'key');
});

test('jsonInsertion: empty inline array', () => {
  const text = '{"a": []}';
  const ins = jsonInsertion(text, 7);
  assert.equal(ins.type, 'array');
  const { out, sel } = apply(text, ins);
  assert.equal(out, '{"a": [""]}');
  assert.equal(sel, ''); // collapsed caret between the quotes
  assert.equal(out[ins.selStart - 1] + out[ins.selStart], '""');
});

test('jsonInsertion: inline array with elements appends after the last', () => {
  const text = '{"a": [1, 2]}';
  const { out } = apply(text, jsonInsertion(text, 8));
  assert.equal(out, '{"a": [1, 2, ""]}');
});

test('jsonInsertion: inline object with entries appends after the last', () => {
  const text = '{"a": 1}';
  const { out, sel } = apply(text, jsonInsertion(text, 4));
  assert.equal(out, '{"a": 1, "key": ""}');
  assert.equal(sel, 'key');
});

test('jsonInsertion: multiline object matches element indent', () => {
  const text = '{\n  "a": 1\n}';
  const { out } = apply(text, jsonInsertion(text, 5));
  assert.equal(out, '{\n  "a": 1,\n  "key": ""\n}');
});

test('jsonInsertion: multiline empty object indents one step past the bracket', () => {
  const text = '{\n  "a": {\n  }\n}';
  const { out } = apply(text, jsonInsertion(text, 11));
  assert.equal(out, '{\n  "a": {\n    "key": ""\n  }\n}');
});

test('jsonInsertion: multiline array whose last element is a nested object', () => {
  const text = '[\n  {\n    "a": 1\n  }\n]';
  const ins = jsonInsertion(text, 1); // caret right after [ → the array, not the object
  assert.equal(ins.type, 'array');
  const { out } = apply(text, ins);
  assert.equal(out, '[\n  {\n    "a": 1\n  },\n  ""\n]');
});

test('jsonInsertion: caret picks the innermost container', () => {
  const text = '{"a": [1]}';
  assert.equal(jsonInsertion(text, 8).type, 'array');
  assert.equal(jsonInsertion(text, 5).type, 'object');
});

test('jsonInsertion: tab-indented file inserts with tabs', () => {
  const text = '{\n\t"a": {\n\t}\n}';
  const { out } = apply(text, jsonInsertion(text, 10));
  assert.equal(out, '{\n\t"a": {\n\t\t"key": ""\n\t}\n}');
});

test('jsonInsertion: tolerates an existing trailing comma', () => {
  const text = '{\n  "a": 1,\n}';
  const { out } = apply(text, jsonInsertion(text, 5));
  assert.equal(out, '{\n  "a": 1,\n  "key": ""\n}');
});

test('jsonInsertion: brackets inside strings are ignored', () => {
  const text = '{"a": "[{"}';
  const ins = jsonInsertion(text, 9); // caret inside the string value
  assert.equal(ins.type, 'object');
  const { out } = apply(text, ins);
  assert.equal(out, '{"a": "[{", "key": ""}');
});
