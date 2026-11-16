// The quick-model buttons under New session (shown with the Low/Mid/High quick buttons,
// Settings → General): one click spawns a session on that model at the remembered effort.
// GPT on the left, Claude on the right. Pure so test/quick-models.test.mjs can check every
// id is a real model in settings.js (MODELS / CODEX_MODELS).
export const QUICK_GPT_MODELS = [
  { id: 'codex:gpt-6-astra', label: 'Astra', hint: 'Best' },
  { id: 'codex:gpt-6.1-sol', label: 'Sol', hint: 'Best value' },
  { id: 'codex:gpt-6-luna', label: 'Luna', hint: 'Cheapest' },
];

export const QUICK_CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
];
