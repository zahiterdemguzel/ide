// Pure (Electron-free) half of the slash-command list the phone's chat composer
// autocompletes after "/". The fs walk lives in slash-commands.js; naming and
// front-matter parsing are here so they stay unit-tested
// (test/slash-commands-lib.test.js).

// Claude Code's own commands. There is no way to ask the CLI for them (it owns them
// inside the TUI), so the list is maintained here; an unknown one still *works* when
// typed — this only drives the autocomplete menu, never what may be sent.
const BUILTIN = [
  { name: '/clear', description: 'Clear conversation history' },
  { name: '/compact', description: 'Compact the conversation to free up context' },
  { name: '/context', description: 'Show what is using the context window' },
  { name: '/cost', description: 'Show token usage and cost for this session' },
  { name: '/diff', description: 'Review the changes made in this session' },
  { name: '/help', description: 'List the available commands' },
  { name: '/init', description: 'Analyse the project and write a CLAUDE.md' },
  { name: '/mcp', description: 'Manage MCP servers' },
  { name: '/memory', description: 'Edit the project and user memory files' },
  { name: '/model', description: 'Change the model this session runs' },
  { name: '/review', description: 'Review a pull request' },
  { name: '/status', description: 'Show version, model and account status' },
  { name: '/vim', description: 'Toggle vim keybindings in the prompt' },
].map((c) => ({ ...c, source: 'builtin' }));

// A command file's name is its path under commands/, namespaced with ":" the way
// Claude Code namespaces a subfolder (commands/git/sync.md → /git:sync).
function commandName(relPath) {
  return '/' + relPath
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .filter(Boolean)
    .join(':');
}

// A command file may open with YAML front matter; `description:` is what the menu
// shows. Without it, the first line of prose says what the command does well enough.
function commandDescription(text) {
  const src = String(text || '');
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (fm) {
    const d = /^description:\s*(.+)$/m.exec(fm[1]);
    if (d) return d[1].trim().replace(/^["']|["']$/g, '');
  }
  const body = fm ? src.slice(fm[0].length) : src;
  const first = body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
  return (first || '').slice(0, 120);
}

// Project commands shadow user ones of the same name, as they do in the CLI, and
// both shadow a builtin. Sorted by name so the menu has a stable order.
function mergeCommands(...groups) {
  const by = new Map();
  for (const group of groups) for (const c of group) by.set(c.name, c);
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { BUILTIN, commandName, commandDescription, mergeCommands };
