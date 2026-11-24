const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  slugify, isSafeAgentId, parseClaudeAgent, serializeClaudeAgent, parseCodexAgent, serializeCodexAgent, agentProblem,
} = require('../src/main/agents-lib');

const claudeFile = `---
name: code-reviewer
description: "Reviews code: fast"
tools: Read, Grep
model: sonnet
color: blue
permissionMode: plan
skills:
  - lint
---

You review code.
Be brief.
`;

test('claude: parses frontmatter, body and keeps unknown keys', () => {
  const agent = parseClaudeAgent(claudeFile, 'code-reviewer');
  assert.equal(agent.name, 'code-reviewer');
  assert.equal(agent.description, 'Reviews code: fast');
  assert.deepEqual(agent.tools, ['Read', 'Grep']);
  assert.equal(agent.model, 'sonnet');
  assert.equal(agent.instructions, 'You review code.\nBe brief.');
  assert.match(agent.extra, /permissionMode: plan\nskills:\n {2}- lint/);
});

test('claude: serialize round-trips through parse', () => {
  const agent = parseClaudeAgent(claudeFile, 'code-reviewer');
  assert.deepEqual(parseClaudeAgent(serializeClaudeAgent(agent), 'code-reviewer'), agent);
});

test('claude: tools as a YAML list and a file without frontmatter', () => {
  const listed = parseClaudeAgent('---\nname: a\ndescription: d\ntools:\n  - Read\n  - Bash\n---\nbody', 'a');
  assert.deepEqual(listed.tools, ['Read', 'Bash']);
  const bare = parseClaudeAgent('just a prompt', 'bare');
  assert.equal(bare.name, 'bare');
  assert.equal(bare.instructions, 'just a prompt');
});

const codexFile = `name = "reviewer"
description = "Reviews \\"diffs\\""
model = "gpt-6.1-sol"
model_reasoning_effort = "high"
sandbox_mode = "read-only"
nickname_candidates = ["Atlas"]
developer_instructions = """
Review the diff.
Mention risks.
"""

[mcp_servers.docs]
url = "https://example.com/mcp"
`;

test('codex: parses known keys, multi-line instructions and keeps tables', () => {
  const agent = parseCodexAgent(codexFile, 'reviewer');
  assert.equal(agent.description, 'Reviews "diffs"');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.sandbox, 'read-only');
  assert.equal(agent.instructions, 'Review the diff.\nMention risks.');
  assert.match(agent.extra, /nickname_candidates = \["Atlas"\]/);
  assert.match(agent.extra, /\[mcp_servers\.docs\]\nurl = /);
});

test('codex: serialize round-trips through parse, including instructions with quotes', () => {
  const agent = parseCodexAgent(codexFile, 'reviewer');
  agent.instructions = "It's \"tricky\" ''' text\nsecond line";
  assert.deepEqual(parseCodexAgent(serializeCodexAgent(agent), 'reviewer'), agent);
});

test('slugify and id safety', () => {
  assert.equal(slugify('  Code Reviewer! '), 'code-reviewer');
  assert.equal(slugify('Çalışan Ajan'), 'calisan-ajan');
  assert.ok(isSafeAgentId('code-reviewer'));
  assert.ok(!isSafeAgentId('../evil'));
  assert.ok(!isSafeAgentId('a/b'));
  assert.ok(!isSafeAgentId('a..b'));
});

test('agentProblem: names the first missing piece', () => {
  const ok = { provider: 'claude', name: 'a-b', description: 'd', instructions: 'x' };
  assert.equal(agentProblem(ok), null);
  assert.equal(agentProblem({ ...ok, name: '' }), 'agents.error.name');
  assert.equal(agentProblem({ ...ok, name: 'Bad Name' }), 'agents.error.claudeName');
  assert.equal(agentProblem({ ...ok, description: '' }), 'agents.error.description');
  assert.equal(agentProblem({ ...ok, instructions: ' ' }), 'agents.error.instructions');
  assert.equal(agentProblem({ ...ok, provider: 'x' }), 'agents.error.provider');
  assert.equal(agentProblem({ provider: 'codex', name: 'Any Name', instructions: 'x' }), null);
});
