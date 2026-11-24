import { t, setTranslatedText } from '../i18n/index.js';
import { confirmDialog, noticeDialog } from './shared/confirm.js';

// --- Settings → Agents ---
// Lists, creates, edits and deletes the open project's custom agents for Claude
// Code (.claude/agents/*.md) and Codex (.codex/agents/*.toml). Files are owned by
// main (agents.js / agents-lib.js); this module is only the form and the lists.

const CLAUDE_MODELS = ['inherit', 'sonnet', 'opus', 'haiku'];
const CLAUDE_COLORS = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
const CLAUDE_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch'];
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const CODEX_SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

const PROVIDER_LABEL_KEY = { claude: 'agents.claude.title', codex: 'agents.codex.title' };

const projectLabel = document.getElementById('agents-project');
const lists = { claude: document.getElementById('agents-list-claude'), codex: document.getElementById('agents-list-codex') };
const addButtons = { claude: document.getElementById('agents-add-claude'), codex: document.getElementById('agents-add-codex') };
const groups = document.getElementById('agents-groups');
const editorHost = document.getElementById('agents-editor');

let snapshot = { project: null, claude: [], codex: [] };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// --- Lists ---

function agentRow(agent) {
  const row = element('div', 'agent-row');
  row.dataset.searchItem = '';
  const info = element('span', 'settings-label');
  info.append(element('span', 'agent-name', agent.name));
  if (agent.description) info.append(element('small', 'settings-desc agent-desc', agent.description));
  const meta = element('span', 'agent-meta');
  if (agent.model) meta.append(element('span', 'agent-badge', agent.model));
  const edit = element('button', 'settings-secondary agent-action', t('agents.edit'));
  edit.type = 'button';
  edit.dataset.i18n = 'agents.edit';
  edit.onclick = () => openEditor(agent);
  const remove = element('button', 'settings-secondary agent-action agent-delete', t('agents.delete'));
  remove.type = 'button';
  remove.dataset.i18n = 'agents.delete';
  remove.onclick = () => removeAgent(agent);
  row.append(info, meta, edit, remove);
  return row;
}

function renderLists() {
  const hasProject = !!snapshot.project;
  if (hasProject) {
    delete projectLabel.dataset.i18n;
    projectLabel.textContent = snapshot.project.split(/[\\/]/).filter(Boolean).pop();
  } else {
    setTranslatedText(projectLabel, 'agents.noProject');
  }
  for (const provider of ['claude', 'codex']) {
    addButtons[provider].disabled = !hasProject;
    const list = lists[provider];
    list.replaceChildren();
    const agents = snapshot[provider];
    if (!agents.length) {
      const empty = element('div', 'agent-empty', t('agents.empty'));
      empty.dataset.i18n = 'agents.empty';
      list.append(empty);
    } else {
      list.append(...agents.map(agentRow));
    }
  }
}

export async function refreshAgentsSettings() {
  try { snapshot = await window.api.listAgents(); }
  catch { snapshot = { project: null, claude: [], codex: [] }; }
  closeEditor();
  renderLists();
}

async function removeAgent(agent) {
  const fileLabel = `${agent.id}${agent.provider === 'codex' ? '.toml' : '.md'}`;
  const confirmed = await confirmDialog({
    title: t('agents.deleteTitle'),
    message: `${t('agents.deleteMessage')} ${fileLabel}`,
    ok: t('agents.delete'),
    danger: true,
  });
  if (!confirmed) return;
  const result = await window.api.deleteAgent({ provider: agent.provider, id: agent.id });
  if (result.error) await noticeDialog({ title: t('agents.error.title'), message: t(result.error) });
  await refreshAgentsSettings();
}

// --- Editor form ---

function field(labelKey, control, hintKey) {
  const row = element('label', 'settings-row agent-field');
  const label = element('span', 'settings-label');
  const title = element('span', null, t(labelKey));
  title.dataset.i18n = labelKey;
  label.append(title);
  if (hintKey) {
    const hint = element('small', 'settings-desc', t(hintKey));
    hint.dataset.i18n = hintKey;
    label.append(hint);
  }
  row.append(label, control);
  return row;
}

function textInput(value, placeholderKey) {
  const input = element('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = value || '';
  if (placeholderKey) {
    input.placeholder = t(placeholderKey);
    input.dataset.i18nPlaceholder = placeholderKey;
  }
  return input;
}

// A dropdown of fixed values plus a blank "default" entry; a value the file already
// holds that isn't in the list (a full model id) stays selectable.
function selectOf(values, current, blankLabel) {
  const select = element('select');
  const options = [...values];
  if (current && !options.includes(current)) options.push(current);
  select.append(new Option(blankLabel, ''));
  for (const value of options) select.append(new Option(value, value));
  select.value = current || '';
  return select;
}

function toolPicker(selectedTools) {
  const wrap = element('div', 'agent-tools');
  const input = textInput(selectedTools.join(', '), 'agents.tools.placeholder');
  const chips = element('div', 'agent-chips');
  const currentTools = () => input.value.split(',').map((tool) => tool.trim()).filter(Boolean);
  const syncChips = () => {
    const active = currentTools();
    chips.querySelectorAll('.agent-chip').forEach((chip) => chip.classList.toggle('active', active.includes(chip.textContent)));
  };
  for (const tool of CLAUDE_TOOLS) {
    const chip = element('button', 'agent-chip', tool);
    chip.type = 'button';
    chip.onclick = () => {
      const active = currentTools();
      input.value = (active.includes(tool) ? active.filter((name) => name !== tool) : [...active, tool]).join(', ');
      syncChips();
    };
    chips.append(chip);
  }
  input.addEventListener('input', syncChips);
  syncChips();
  wrap.append(input, chips);
  return { wrap, read: currentTools };
}

function buildForm(agent) {
  const isClaude = agent.provider === 'claude';
  const name = textInput(agent.name, isClaude ? 'agents.name.placeholderClaude' : 'agents.name.placeholderCodex');
  const description = textInput(agent.description, 'agents.description.placeholder');
  const model = isClaude
    ? selectOf(CLAUDE_MODELS, agent.model, t('agents.default'))
    : textInput(agent.model, 'agents.model.placeholderCodex');
  const instructions = element('textarea', 'agent-instructions');
  instructions.value = agent.instructions || '';
  instructions.spellcheck = false;
  instructions.rows = 12;
  instructions.placeholder = t('agents.instructions.placeholder');
  instructions.dataset.i18nPlaceholder = 'agents.instructions.placeholder';

  const rows = [
    field('agents.field.name', name, isClaude ? 'agents.field.nameHintClaude' : null),
    field('agents.field.description', description),
    field('agents.field.model', model),
  ];
  let readTools = () => [];
  let color = null;
  let effort = null;
  let sandbox = null;
  if (isClaude) {
    const picker = toolPicker(agent.tools || []);
    readTools = picker.read;
    color = selectOf(CLAUDE_COLORS, agent.color, t('agents.default'));
    rows.push(field('agents.field.tools', picker.wrap, 'agents.field.toolsHint'), field('agents.field.color', color));
  } else {
    effort = selectOf(CODEX_EFFORTS, agent.effort, t('agents.default'));
    sandbox = selectOf(CODEX_SANDBOXES, agent.sandbox, t('agents.default'));
    rows.push(field('agents.field.effort', effort), field('agents.field.sandbox', sandbox));
  }
  const instructionsRow = element('div', 'agent-instructions-row');
  const instructionsTitle = element('span', 'agent-instructions-title', t('agents.field.instructions'));
  instructionsTitle.dataset.i18n = 'agents.field.instructions';
  instructionsRow.append(instructionsTitle, instructions);
  rows.push(instructionsRow);

  const collect = () => ({
    provider: agent.provider,
    id: agent.id,
    name: name.value.trim(),
    description: description.value.trim(),
    model: model.value.trim(),
    tools: readTools(),
    color: color ? color.value : '',
    effort: effort ? effort.value : '',
    sandbox: sandbox ? sandbox.value : '',
    instructions: instructions.value,
    extra: agent.extra || '',
  });
  return { rows, collect };
}

function blankAgent(provider) {
  return {
    provider, id: '', name: '', description: '', model: '', tools: [], color: '', effort: '', sandbox: '', instructions: '', extra: '',
  };
}

function openEditor(agent) {
  const isNew = !agent.id;
  const { rows, collect } = buildForm(agent);

  const title = element('div', 'settings-group-title');
  setTranslatedText(title, isNew ? 'agents.newTitle' : 'agents.editTitle');
  const provider = element('span', 'agent-badge', t(PROVIDER_LABEL_KEY[agent.provider]));
  provider.dataset.i18n = PROVIDER_LABEL_KEY[agent.provider];
  title.append(' ', provider);

  const card = element('div', 'settings-card agent-card');
  card.append(...rows);

  const error = element('div', 'agent-error');
  error.hidden = true;
  const save = element('button', 'settings-primary', t('agents.save'));
  save.type = 'button';
  save.dataset.i18n = 'agents.save';
  const cancel = element('button', 'settings-secondary', t('agents.cancel'));
  cancel.type = 'button';
  cancel.dataset.i18n = 'agents.cancel';
  cancel.onclick = closeEditor;
  save.onclick = async () => {
    const result = await window.api.saveAgent(collect());
    if (result.error) {
      error.hidden = false;
      error.textContent = result.detail ? `${t(result.error)} ${result.detail}` : t(result.error);
      return;
    }
    await refreshAgentsSettings();
  };
  const actions = element('div', 'agent-actions');
  actions.append(save, cancel);

  editorHost.replaceChildren(title, card, error, actions);
  editorHost.hidden = false;
  groups.hidden = true;
  editorHost.querySelector('input')?.focus();
}

function closeEditor() {
  editorHost.hidden = true;
  editorHost.replaceChildren();
  groups.hidden = false;
}

export function initAgentsSettings() {
  for (const provider of ['claude', 'codex']) {
    addButtons[provider].onclick = () => openEditor(blankAgent(provider));
  }
  refreshAgentsSettings();
}
