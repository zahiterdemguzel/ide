// Pure (Electron-free) extraction of the images an agent was shown by a tool call,
// read off a PostToolUse hook payload. The hook server turns each into a
// `session-image` event so the session's "Seen by AI" panel can show the user
// exactly what the model looked at. Unit-tested in test/seen-images-lib.test.js.

const MIME_BY_EXT = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};

// Tool results nest content blocks a few levels deep at most (`{ content: [...] }`,
// `{ file: {...} }`); the cap keeps a pathological payload from costing a deep walk.
const MAX_WALK_DEPTH = 5;

function imageMimeForPath(filePath) {
  const ext = String(filePath || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || '';
}

// One image block in any of the shapes a tool result carries it:
//   MCP content block       { type: 'image', data, mimeType }
//   Messages API block      { type: 'image', source: { type: 'base64', media_type, data } }
//   Claude Code Read result { type: 'image', file: { base64, type } }
function imageFromBlock(block) {
  if (!block || block.type !== 'image') return null;
  if (typeof block.data === 'string' && block.data) {
    return { mimeType: block.mimeType || 'image/png', base64: block.data };
  }
  const src = block.source;
  if (src && src.type === 'base64' && typeof src.data === 'string' && src.data) {
    return { mimeType: src.media_type || 'image/png', base64: src.data };
  }
  const file = block.file;
  if (file && typeof file.base64 === 'string' && file.base64) {
    return { mimeType: file.type || 'image/png', base64: file.base64 };
  }
  return null;
}

function collectImageBlocks(value, found = [], depth = 0) {
  if (!value || typeof value !== 'object' || depth > MAX_WALK_DEPTH) return found;
  const image = imageFromBlock(value);
  if (image) { found.push(image); return found; }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    collectImageBlocks(child, found, depth + 1);
  }
  return found;
}

// `mcp__playwright__browser_take_screenshot` → `playwright · browser_take_screenshot`.
function toolLabel(toolName) {
  const parts = String(toolName || '').split('__');
  return parts[0] === 'mcp' && parts.length >= 3 ? `${parts[1]} · ${parts.slice(2).join('__')}` : String(toolName || '');
}

// The images a PostToolUse payload handed the model, as
// `{ tool, label, images: [{ mimeType, base64 } | { mimeType, filePath }] }`,
// or null when it carried none. Bytes in the tool result win (they are exactly
// what the model saw, after Claude Code's own downscaling); a `Read` of an image
// file whose result omits them falls back to the file path for main to read.
function seenImagesFromPayload(payload) {
  if (!payload || payload.hook_event_name !== 'PostToolUse') return null;
  const tool = String(payload.tool_name || '');
  const filePath = payload.tool_input && payload.tool_input.file_path;
  const images = collectImageBlocks(payload.tool_response);
  if (!images.length && tool === 'Read' && imageMimeForPath(filePath)) {
    images.push({ mimeType: imageMimeForPath(filePath), filePath });
  }
  if (!images.length) return null;
  const label = tool === 'Read' && filePath ? String(filePath).split(/[\\/]/).pop() : toolLabel(tool);
  return { tool, label, images };
}

module.exports = { seenImagesFromPayload, imageMimeForPath, toolLabel };
