// Selectable agent models for a new session — the mobile mirror of the desktop
// list in src/renderer/settings.js. The id is what main maps to ANTHROPIC_MODEL
// (see src/main/agent-models.js); `default` sets no env var and lets the CLI
// resolve the model itself. Keep the two lists in step.
import * as SecureStore from 'expo-secure-store';

export type Model = { id: string; name: string };

export const MODELS: Model[] = [
  { id: 'default', name: 'Default (inherit)' },
  { id: 'fable', name: 'Fable' },
  { id: 'opus', name: 'Opus' },
  { id: 'sonnet', name: 'Sonnet' },
  { id: 'haiku', name: 'Haiku' },
];

export const DEFAULT_MODEL = 'default';

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

const KEY_MODEL = 'ide.sessionModel';

// The last model picked from the menu, reused for the next session so the plain
// "New session" button never has to ask. An id no longer in MODELS (list edited
// between app versions) falls back to the inherit default.
export async function getSessionModel(): Promise<string> {
  try {
    const v = await SecureStore.getItemAsync(KEY_MODEL);
    return MODELS.some((m) => m.id === v) ? (v as string) : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

export async function setSessionModel(id: string): Promise<void> {
  const known = MODELS.some((m) => m.id === id) ? id : DEFAULT_MODEL;
  try {
    await SecureStore.setItemAsync(KEY_MODEL, known);
  } catch {
    // A write failure only costs the sticky default; creating the session matters more.
  }
}

// Suffix for the New session button: "(Opus)", "(Sonnet)", … for whatever was
// picked last. Nothing has been picked yet on a fresh install (the CLI resolves
// the model itself), and there's no name worth showing for that.
export function modelSuffix(id: string): string {
  if (id === DEFAULT_MODEL) return '';
  const m = MODELS.find((x) => x.id === id);
  return m ? ` (${m.name})` : '';
}

// A running session's model, as the chat's badge says it. "Default (inherit)" is just
// "Default" here (the desktop badge does the same), and a session carrying a model this
// build doesn't know about still shows what it is running rather than lying about it.
export function modelBadgeName(id: string): string {
  if (!id || id === DEFAULT_MODEL) return 'Default';
  return MODELS.find((m) => m.id === id)?.name ?? id;
}

export function effortName(id: string): string {
  if (!id) return 'Auto';
  return EFFORTS.find((e) => e.id === id)?.name ?? id;
}
