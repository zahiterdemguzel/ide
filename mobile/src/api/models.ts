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

// GPT models run inside Claude Code through the desktop's account proxy — the mobile
// mirror of CHATGPT_MODELS in src/renderer/settings.js (keep in step). Fixed for life,
// like a local model.
export const CHATGPT_MODELS: Model[] = [
  { id: 'chatgpt:sol', name: 'Sol (ChatGPT via Claude Code)' },
  { id: 'chatgpt:astra', name: 'Astra (ChatGPT via Claude Code)' },
  { id: 'chatgpt:terra', name: 'Terra (ChatGPT via Claude Code)' },
  { id: 'chatgpt:luna', name: 'Luna (ChatGPT via Claude Code)' },
];

// The OpenAI Codex CLI's models. No longer offered for new sessions (GPT runs through
// Claude Code), but kept so a session started on the Codex CLI before still gets its
// label and same-family switches.
export const CODEX_MODELS: Model[] = [
  { id: 'codex:astra', name: 'Astra (latest, Codex)' },
  { id: 'codex:sol', name: 'Sol (latest, Codex)' },
  { id: 'codex:terra', name: 'Terra (latest, Codex)' },
  { id: 'codex:luna', name: 'Luna (latest, Codex)' },
];

export const DEFAULT_MODEL = 'default';
// Where a saved GPT pick lands when its family isn't listed — mirror of
// DEFAULT_CHATGPT_MODEL in src/renderer/settings.js.
const DEFAULT_CHATGPT_MODEL = 'chatgpt:sol';

export const isCodexId = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith('codex:');
export const isChatgptId = (v: string | null | undefined): boolean => typeof v === 'string' && v.startsWith('chatgpt:');

// A saved Codex CLI pick becomes the same GPT family through Claude Code — mirror of
// codexToChatgptId in src/renderer/settings.js.
function codexToChatgptId(id: string | null | undefined): string | null | undefined {
  if (!isCodexId(id)) return id;
  const family = (id as string).match(/(sol|astra|terra|luna)$/)?.[1];
  return family ? `chatgpt:${family}` : DEFAULT_CHATGPT_MODEL;
}

// Which CLI family a model id runs on — mirror of agent-providers.modelFamily.
export type ModelFamily = 'claude' | 'codex' | 'ollama' | 'chatgpt';
export function modelFamily(id: string | null | undefined): ModelFamily {
  if (isCodexId(id)) return 'codex';
  if (isOllamaId(id)) return 'ollama';
  if (isChatgptId(id)) return 'chatgpt';
  return 'claude';
}

// The models a session on `currentId` may switch to: its own family only, and a
// local (ollama:) or ChatGPT model is fixed for life. Main enforces the same rule.
export function switchableModels(currentId: string | null | undefined, all: Model[]): Model[] {
  const family = modelFamily(currentId);
  if (family === 'ollama' || family === 'chatgpt') return [];
  return all.filter((m) => modelFamily(m.id) === family);
}

// Codex reasons on its own ladder — no `max`, and no `minimal` either: the API rejects
// that level outright alongside Codex's web_search tool, so it's a row that can only
// break the session (mirror of CODEX_EFFORT_LEVELS in src/main/agent-effort.js).
export const CODEX_EFFORTS: Effort[] = [
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

// How hard the model thinks before it answers. Like the model, the level picked in the
// chat's badge is remembered (setSessionEffort) and becomes the default for the next
// session. There is no `auto` row: every session runs at a level the badge can name, so
// "the model's own default" — a level the user never chose and the badge can't show —
// isn't offerable. Keep in step with EFFORT_LEVELS in src/main/agent-effort.js.
export type Effort = { id: string; name: string; hint: string };

export const EFFORTS: Effort[] = [
  { id: 'low', name: 'Low', hint: 'Fastest, barely thinks' },
  { id: 'medium', name: 'Medium', hint: 'Balanced' },
  { id: 'high', name: 'High', hint: 'Thinks before it acts' },
  { id: 'xhigh', name: 'Extra high', hint: 'For hard problems' },
  { id: 'max', name: 'Max', hint: 'Deepest thinking, slowest' },
];

// Mirror of DEFAULT_EFFORT in src/main/agent-effort.js — the fallback before anything
// has been picked. The desktop resolves the real level at creation; this only decides
// what a fresh install starts on.
export const DEFAULT_EFFORT = 'medium';

const KEY_MODEL = storageKey('sessionModel');
const KEY_EFFORT = storageKey('sessionEffort');

// The last model picked from the menu, reused for the next session so the plain
// "New session" button never has to ask. An id no longer in MODELS (list edited
// between app versions) falls back to the inherit default.
export async function getSessionModel(): Promise<string> {
  try {
    const saved = await SecureStore.getItemAsync(KEY_MODEL);
    const v = codexToChatgptId(saved);
    if (MODELS.some((m) => m.id === v) || CHATGPT_MODELS.some((m) => m.id === v) || isOllamaId(v)) return v as string;
    return isChatgptId(v) ? DEFAULT_CHATGPT_MODEL : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function setSessionModel(id: string): Promise<void> {
  const v = codexToChatgptId(id) as string;
  const known = MODELS.some((m) => m.id === v) || CHATGPT_MODELS.some((m) => m.id === v) || isOllamaId(v) ? v : DEFAULT_MODEL;
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
  const m = MODELS.find((x) => x.id === id) ?? CHATGPT_MODELS.find((x) => x.id === id) ?? CODEX_MODELS.find((x) => x.id === id);
  if (m) return ` (${m.name})`;
  if (isOllamaId(id)) return ` (${ollamaLabel(id)})`;
  return '';
}

// A running session's model, as the chat's badge says it. "Default (inherit)" is just
// "Default" here (the desktop badge does the same), and a session carrying a model this
// build doesn't know about still shows what it is running rather than lying about it.
export function modelBadgeName(id: string): string {
  if (!id || id === DEFAULT_MODEL) return 'Default';
  return MODELS.find((m) => m.id === id)?.name ?? CHATGPT_MODELS.find((m) => m.id === id)?.name ?? CODEX_MODELS.find((m) => m.id === id)?.name ?? (isOllamaId(id) ? ollamaLabel(id) : id);
}

// The last effort picked from the chat's badge, reused as the starting level for the
// next session. Stored without a family: the ladders overlap, and the desktop clamps
// what doesn't fit (a remembered `max` landing on a Codex session) at creation, so the
// raw last pick is the honest thing to keep here.
export async function getSessionEffort(): Promise<string> {
  try {
    const v = await SecureStore.getItemAsync(KEY_EFFORT);
    return EFFORTS.some((e) => e.id === v) ? (v as string) : DEFAULT_EFFORT;
  } catch {
    return DEFAULT_EFFORT;
  }
}

export async function setSessionEffort(id: string): Promise<void> {
  if (!EFFORTS.some((e) => e.id === id)) return;
  try {
    await SecureStore.setItemAsync(KEY_EFFORT, id);
  } catch {
    // A write failure only costs the sticky default; the session's own level still took.
  }
}

// A running session's effort, as the chat's badge says it. Family-aware like the
// desktop's effortNameForFamily: the ladders differ (no `max` on Codex), and a level
// the session's family can't offer still shows as what it is running rather than being
// relabelled to something it isn't.
export function effortName(id: string, modelId?: string | null): string {
  const level = id || DEFAULT_EFFORT;
  return effortsFor(modelId).find((e) => e.id === level)?.name ?? level;
}
