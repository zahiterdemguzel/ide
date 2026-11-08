const test = require('node:test');
const assert = require('node:assert/strict');
const { seenImagesFromPayload, imageMimeForPath, toolLabel } = require('../src/main/seen-images-lib');

const post = (tool_name, tool_input, tool_response) => ({ hook_event_name: 'PostToolUse', tool_name, tool_input, tool_response });

test('seenImagesFromPayload: a Read of an image uses the bytes in its result', () => {
  const seen = seenImagesFromPayload(post('Read', { file_path: '/repo/shots/home.png' },
    { type: 'image', file: { base64: 'AAAA', type: 'image/jpeg' } }));
  assert.deepEqual(seen, { tool: 'Read', label: 'home.png', images: [{ mimeType: 'image/jpeg', base64: 'AAAA' }] });
});

test('seenImagesFromPayload: a Read whose result carries no bytes falls back to the file path', () => {
  const seen = seenImagesFromPayload(post('Read', { file_path: 'C:\\shots\\Home.WEBP' }, { type: 'text' }));
  assert.deepEqual(seen.images, [{ mimeType: 'image/webp', filePath: 'C:\\shots\\Home.WEBP' }]);
  assert.equal(seen.label, 'Home.WEBP');
});

test('seenImagesFromPayload: a Read of a text file shows nothing', () => {
  assert.equal(seenImagesFromPayload(post('Read', { file_path: '/repo/a.js' }, { type: 'text', file: { content: 'x' } })), null);
});

test('seenImagesFromPayload: finds MCP and Messages-API image blocks nested in a result', () => {
  const seen = seenImagesFromPayload(post('mcp__playwright__browser_take_screenshot', {}, {
    content: [
      { type: 'text', text: 'Took a screenshot' },
      { type: 'image', data: 'BBBB', mimeType: 'image/png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/gif', data: 'CCCC' } },
    ],
  }));
  assert.equal(seen.label, 'playwright · browser_take_screenshot');
  assert.deepEqual(seen.images, [
    { mimeType: 'image/png', base64: 'BBBB' },
    { mimeType: 'image/gif', base64: 'CCCC' },
  ]);
});

test('Codex view_image result uses the returned bytes and the file extension for its generic MIME', () => {
  const seen = seenImagesFromPayload(post('view_image', { path: '/tmp/screen.png' }, [
    { type: 'input_image', image_url: 'data:application/octet-stream;base64,AAAA' },
  ]));
  assert.deepEqual(seen, { tool: 'view_image', label: 'screen.png', images: [{ mimeType: 'image/png', base64: 'AAAA' }] });
  assert.equal(seenImagesFromPayload(post('view_image', { path: '/tmp/missing.png' }, [{ type: 'text', text: 'failed' }])), null);
});

test('seenImagesFromPayload: ignores other events and image-free results', () => {
  assert.equal(seenImagesFromPayload({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: 'a.png' } }), null);
  assert.equal(seenImagesFromPayload(post('Bash', { command: 'ls' }, { stdout: 'a.png' })), null);
  assert.equal(seenImagesFromPayload(post('mcp__x__y', {}, [{ type: 'image', data: '' }])), null);
  assert.equal(seenImagesFromPayload(null), null);
});

test('imageMimeForPath / toolLabel', () => {
  assert.equal(imageMimeForPath('x.JPG'), 'image/jpeg');
  assert.equal(imageMimeForPath('x.svg'), '');
  assert.equal(toolLabel('mcp__computer-use__screenshot'), 'computer-use · screenshot');
  assert.equal(toolLabel('WebFetch'), 'WebFetch');
});
