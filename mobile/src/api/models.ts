// Selectable agent models for a new session — the mobile mirror of the desktop
// list in src/renderer/settings.js. The id is what main maps to ANTHROPIC_MODEL
// (see src/main/agent-models.js); `default` sets no env var and lets the CLI
// resolve the model itself. Keep the two lists in step.
import * as SecureStore from 'expo-secure-store';
import { storageKey } from './storage';

export type Model = { id: string; name: string };

export const MODELS: Model[] = [
  { id: 'default', name: 'Default (inherit)' },
  { id: 'fable', name: 'Fable' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];

// The OpenAI Codex CLI's models — the mobile mirror of CODEX_MODELS in
// src/renderer/settings.js (keep in step). A codex: session is locked to the
// codex family; the pickers filter through switchableModels below.
export const CODEX_MODELS: Model[] = [
  { id: 'codex:gpt-5.5', name: 'GPT-5.5 (Codex)' },
  { id: 'codex:gpt-5.4', name: 'GPT-5.4 (Codex)' },
  { id: 'codex:gpt-5.4-mini', name: 'GPT-5.4 Mini (Codex)' },
];

export const DEFAULT_MODEL = 'default';

export const isCodexId = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith('codex:');

// Which CLI family a model id runs on — mirror of agent-providers.modelFamily.
export type ModelFamily = 'claude' | 'codex' | 'ollama';
export function modelFamily(id: string | null | undefined): ModelFamily {
  if (isCodexId(id)) return 'codex';
  if (isOllamaId(id)) return 'ollama';
  return 'claude';
}

// The models a session on `currentId` may switch to: its own family only, and a
// local (ollama:) model is fixed for life. Main enforces the same rule.
export function switchableModels(currentId: string | null | undefined, all: Model[]): Model[] {
  const family = modelFamily(currentId);
  if (family === 'ollama') return [];
  return all.filter((m) => modelFamily(m.id) === family);
}

// Codex reasons on its own ladder — `minimal` exists, `max` doesn't (mirror of
// CODEX_EFFORT_LEVELS in src/main/agent-effort.js).
export const CODEX_EFFORTS: Effort[] = [
  { id: 'auto', name: 'Auto', hint: "The model's own default" },
  { id: 'minimal', name: 'Minimal', hint: 'Fastest, barely thinks' },
  { id: 'low', name: 'Low', hint: 'Quick answers' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
];

export function effortsFor(modelId: string | null | undefined): Effort[] {
  return modelFamily(modelId) === 'codex' ? CODEX_EFFORTS : EFFORTS;
}

// An installed Ollama custom model, its id namespaced `ollama:<name>` (the desktop
// convention — see src/main/ollama-models-lib.js) so it never collides with a
// Claude alias. The phone can *pick* these (fetched read-only via `ollama-list`)
// but not install them — management is desktop-only.
export type OllamaModel = { id: string; name: string; size?: number | null; fit?: { level: string } };
export const isOllamaId = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith('ollama:');
export const ollamaLabel = (id: string): string => (isOllamaId(id) ? id.slice('ollama:'.length) : id);

// How hard the model thinks before it answers. Unlike the model, this is never picked
// up front — a session is created at its model's own default and the effort is switched
// on it from the chat (set-session-effort), which is why nothing here is remembered for
// the next session. `auto` is a real choice (reset to the model's default), not a
// "nothing selected" sentinel. Keep in step with EFFORT_LEVELS in src/main/agent-effort.js.
export type Effort = { id: string; name: string; hint: string };

export const EFFORTS: Effort[] = [
  { id: 'auto', name: 'Auto', hint: "The model's own default" },
  { id: 'low', name: 'Low', hint: 'Fastest, barely thinks' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
  { id: 'max', name: 'Max', hint: 'Deepest thinking, slowest' },
];

export const DEFAULT_EFFORT = 'auto';

const KEY_MODEL = storageKey('sessionModel');

// The last model picked from the menu, reused for the next session so the plain
// "New session" button never has to ask. An id no longer in MODELS (list edited
// between app versions) falls back to the inherit default.
export async function getSessionModel(): Promise<string> {
  try {
    const v = await SecureStore.getItemAsync(KEY_MODEL);
    return MODELS.some((m) => m.id === v) || CODEX_MODELS.some((m) => m.id === v) || isOllamaId(v) ? (v as string) : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function setSessionModel(id: string): Promise<void> {
  const known = MODELS.some((m) => m.id === id) || CODEX_MODELS.some((m) => m.id === id) || isOllamaId(id) ? id : DEFAULT_MODEL;
  try {
    await SecureStore.setItemAsync(KEY_MODEL, known);
  } catch {
    // A write failure only costs the sticky default; creating the session matters more.
  }
}

// Suffix for the New session button: "(Opus)", "(Sonnet)", "(llama3.1:8b)", … for
// whatever was picked last. Nothing has been picked yet on a fresh install (the CLI
// resolves the model itself), and there's no name worth showing for that.
export function modelSuffix(id: string): string {
  if (id === DEFAULT_MODEL) return '';
  const m = MODELS.find((x) => x.id === id) ?? CODEX_MODELS.find((x) => x.id === id);
  if (m) return ` (${m.name})`;
  if (isOllamaId(id)) return ` (${ollamaLabel(id)})`;
  return '';
}

// A running session's model, as the chat's badge says it. "Default (inherit)" is just
// "Default" here (the desktop badge does the same), and a session carrying a model this
// build doesn't know about still shows what it is running rather than lying about it.
export function modelBadgeName(id: string): string {
  if (!id || id === DEFAULT_MODEL) return 'Default';
  return MODELS.find((m) => m.id === id)?.name ?? CODEX_MODELS.find((m) => m.id === id)?.name ?? (isOllamaId(id) ? ollamaLabel(id) : id);
}

export function effortName(id: string): string {
  if (!id) return 'Auto';
  return EFFORTS.find((e) => e.id === id)?.name ?? id;
}
