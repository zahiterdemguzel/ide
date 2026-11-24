// Pure (Electron-free) read/write model for a project's custom agents, unit-tested
// in test/agents-lib.test.js.
//
//   Claude Code  .claude/agents/<id>.md    Markdown: YAML frontmatter + system prompt
//   Codex CLI    .codex/agents/<id>.toml   TOML: name, description, developer_instructions, …
//
// Both are parsed into one shape so the settings page edits them the same way:
//   { provider, id, name, description, model, tools[], color, effort, sandbox,
//     instructions, extra }
// `extra` is every part of the file this model doesn't understand (unknown
// frontmatter keys, TOML tables such as [mcp_servers.x]) kept verbatim, so editing
// an agent in the UI never drops settings the user wrote by hand.

const PROVIDERS = {
  claude: { dir: '.claude/agents', ext: '.md' },
  codex: { dir: '.codex/agents', ext: '.toml' },
};

const CLAUDE_KNOWN_KEYS = ['name', 'description', 'tools', 'model', 'color'];
const CODEX_KNOWN_KEYS = ['name', 'description', 'model', 'model_reasoning_effort', 'sandbox_mode', 'developer_instructions'];

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// File-name stem for a new agent: "Code Reviewer!" -> "code-reviewer".
function slugify(name) {
  return String(name || '')
    .replace(/ı/g, 'i') // dotless i has no decomposition
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const isSafeAgentId = (id) => typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..');

// --- Claude: Markdown + YAML frontmatter ---

// A frontmatter scalar: "double quoted" (JSON escapes), 'single quoted' ('' = '), or plain.
function parseYamlScalar(raw) {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try { return JSON.parse(value); } catch { return value.slice(1, -1); }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

// Quote only when a plain scalar would be misread (colon-space, leading symbol, newline…).
function formatYamlScalar(value) {
  const text = String(value);
  const needsQuotes = text === '' || /^[\s\-?:,[\]{}#&*!|>'"%@`]/.test(text) || /:\s|\s#|\n|\s$/.test(text);
  return needsQuotes ? JSON.stringify(text) : text;
}

// Frontmatter -> ordered blocks of raw lines, one per top-level key. A key owns the
// indented / "- item" lines under it, which is what lets unknown keys round-trip.
function splitFrontmatterBlocks(frontmatterText) {
  const blocks = [];
  for (const line of frontmatterText.split('\n')) {
    const keyMatch = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (keyMatch) blocks.push({ key: keyMatch[1], inline: keyMatch[2], lines: [line] });
    else if (blocks.length) blocks[blocks.length - 1].lines.push(line);
  }
  return blocks;
}

function blockListItems(block) {
  return block.lines.slice(1)
    .map((line) => /^\s*-\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map((match) => parseYamlScalar(match[1]));
}

function parseToolList(block) {
  if (!block) return [];
  const inline = block.inline.trim();
  const items = inline ? parseYamlScalar(inline).replace(/^\[|\]$/g, '').split(',') : blockListItems(block);
  return items.map((item) => parseYamlScalar(String(item))).filter(Boolean);
}

function parseClaudeAgent(text, id) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  const agent = {
    provider: 'claude', id, name: id, description: '', model: '', tools: [], color: '',
    effort: '', sandbox: '', instructions: '', extra: '',
  };
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (!match) {
    agent.instructions = normalized.trim();
    return agent;
  }
  const blocks = splitFrontmatterBlocks(match[1]);
  const byKey = (key) => blocks.find((block) => block.key === key);
  const scalar = (key) => (byKey(key) ? parseYamlScalar(byKey(key).inline) : '');
  agent.name = scalar('name') || id;
  agent.description = scalar('description');
  agent.model = scalar('model');
  agent.color = scalar('color');
  agent.tools = parseToolList(byKey('tools'));
  agent.extra = blocks.filter((block) => !CLAUDE_KNOWN_KEYS.includes(block.key))
    .map((block) => block.lines.join('\n')).join('\n').trim();
  agent.instructions = match[2].replace(/^\n+/, '').replace(/\s+$/, '');
  return agent;
}

function serializeClaudeAgent(agent) {
  const lines = ['---', `name: ${formatYamlScalar(agent.name)}`, `description: ${formatYamlScalar(agent.description || '')}`];
  if (agent.tools?.length) lines.push(`tools: ${agent.tools.join(', ')}`);
  if (agent.model) lines.push(`model: ${formatYamlScalar(agent.model)}`);
  if (agent.color) lines.push(`color: ${formatYamlScalar(agent.color)}`);
  if (agent.extra) lines.push(agent.extra);
  lines.push('---', '', (agent.instructions || '').trim(), '');
  return lines.join('\n');
}

// --- Codex: TOML ---

const MULTILINE_DELIMITERS = ['"""', "'''"];

function unescapeTomlBasic(text) {
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_all, code) => {
    if (code.length > 1) return String.fromCodePoint(parseInt(code.slice(1), 16));
    return { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', b: '\b', f: '\f' }[code] ?? code;
  });
}

function parseTomlString(raw) {
  const value = raw.trim();
  for (const delimiter of MULTILINE_DELIMITERS) {
    if (value.startsWith(delimiter)) {
      const body = value.slice(3, value.lastIndexOf(delimiter)).replace(/^\n/, '');
      return delimiter === '"""' ? unescapeTomlBasic(body.replace(/\\\n\s*/g, '')) : body;
    }
  }
  if (value.startsWith('"')) return unescapeTomlBasic(value.slice(1, value.lastIndexOf('"')));
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'"));
  return value;
}

// Top-level `key = value` entries (values may span lines when multi-line strings),
// plus everything from the first [table] header onward as an opaque tail.
function splitTomlEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  let index = 0;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\s*\[/.test(line)) break;
    const keyMatch = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (!keyMatch) {
      if (line.trim()) entries.push({ key: null, raw: line });
      continue;
    }
    const rawLines = [line];
    const delimiter = MULTILINE_DELIMITERS.find((d) => keyMatch[2].trim().startsWith(d));
    if (delimiter && !keyMatch[2].trim().slice(3).includes(delimiter)) {
      while (index + 1 < lines.length) {
        index += 1;
        rawLines.push(lines[index]);
        if (lines[index].includes(delimiter)) break;
      }
    }
    entries.push({ key: keyMatch[1], value: rawLines.join('\n').replace(/^[^=]*=\s*/, ''), raw: rawLines.join('\n') });
  }
  return { entries, tail: lines.slice(index).join('\n') };
}

function parseCodexAgent(text, id) {
  const { entries, tail } = splitTomlEntries(String(text).replace(/\r\n/g, '\n'));
  const valueOf = (key) => {
    const entry = entries.find((candidate) => candidate.key === key);
    return entry ? parseTomlString(entry.value) : '';
  };
  const unknownLines = entries.filter((entry) => !CODEX_KNOWN_KEYS.includes(entry.key)).map((entry) => entry.raw);
  return {
    provider: 'codex', id,
    name: valueOf('name') || id,
    description: valueOf('description'),
    model: valueOf('model'),
    tools: [],
    color: '',
    effort: valueOf('model_reasoning_effort'),
    sandbox: valueOf('sandbox_mode'),
    instructions: valueOf('developer_instructions').replace(/\s+$/, ''),
    extra: [...unknownLines, tail].filter((part) => part.trim()).join('\n').trim(),
  };
}

function formatTomlMultiline(text) {
  // A literal block needs no escaping unless the text itself contains '''.
  if (!text.includes("'''")) return `'''\n${text}\n'''`;
  return `"""\n${text.replace(/\\/g, '\\\\').replace(/"""/g, '\\"""')}\n"""`;
}

function serializeCodexAgent(agent) {
  const lines = [`name = ${JSON.stringify(agent.name)}`, `description = ${JSON.stringify(agent.description || '')}`];
  if (agent.model) lines.push(`model = ${JSON.stringify(agent.model)}`);
  if (agent.effort) lines.push(`model_reasoning_effort = ${JSON.stringify(agent.effort)}`);
  if (agent.sandbox) lines.push(`sandbox_mode = ${JSON.stringify(agent.sandbox)}`);
  lines.push(`developer_instructions = ${formatTomlMultiline((agent.instructions || '').trim())}`);
  if (agent.extra) lines.push('', agent.extra);
  return `${lines.join('\n')}\n`;
}

// --- Shared ---

const parseAgent = (provider, text, id) => (provider === 'codex' ? parseCodexAgent(text, id) : parseClaudeAgent(text, id));
const serializeAgent = (agent) => (agent.provider === 'codex' ? serializeCodexAgent(agent) : serializeClaudeAgent(agent));

// An i18n key naming the first problem, or null when the agent can be saved.
function agentProblem(agent) {
  if (!PROVIDERS[agent.provider]) return 'agents.error.provider';
  if (!String(agent.name || '').trim()) return 'agents.error.name';
  if (agent.provider === 'claude' && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(agent.name)) return 'agents.error.claudeName';
  if (agent.provider === 'claude' && !String(agent.description || '').trim()) return 'agents.error.description';
  if (!String(agent.instructions || '').trim()) return 'agents.error.instructions';
  return null;
}

module.exports = {
  PROVIDERS, slugify, isSafeAgentId, parseAgent, serializeAgent, agentProblem,
  parseClaudeAgent, serializeClaudeAgent, parseCodexAgent, serializeCodexAgent,
};
