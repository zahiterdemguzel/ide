import { DEFAULT_EFFORT } from './effort-levels.js';

// GPT on the left, Claude on the right. The model IDs match the lists in settings.js.
export const QUICK_GPT_MODELS = [
  { id: 'codex:sol', label: 'Sol', hint: 'Best value' },
  { id: 'codex:luna', label: 'Luna', hint: 'Cheapest' },
  { id: 'codex:astra', label: 'Astra', hint: 'Best' },
];

export const QUICK_CLAUDE_MODELS = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'opus', label: 'Opus' },
  { id: 'fable', label: 'Fable' },
];

// Allow small pointer movements during a click without changing gears.
const EFFORT_DRAG_DISTANCE = 12;

export function quickModelDragEffort(deltaY) {
  if (deltaY <= -EFFORT_DRAG_DISTANCE) return 'high';
  if (deltaY >= EFFORT_DRAG_DISTANCE) return 'low';
  return DEFAULT_EFFORT;
}

export function initQuickModelGestures(container, { launch, preview }) {
  let press = null;
  const modelButton = (event) => event.target.closest('.quick-model-btn');

  function clearPress() {
    if (!press) return;
    const { button, pointerId } = press;
    press = null;
    if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
    preview(button, null);
  }

  container.addEventListener('pointerdown', (event) => {
    const button = modelButton(event);
    if (!button || button.disabled || press || !event.isPrimary || event.button !== 0 || event.ctrlKey) return;
    press = { button, pointerId: event.pointerId, startY: event.clientY, effort: DEFAULT_EFFORT };
    button.setPointerCapture(event.pointerId);
    preview(button, press.effort);
  });

  container.addEventListener('pointermove', (event) => {
    if (press?.pointerId !== event.pointerId) return;
    const effort = quickModelDragEffort(event.clientY - press.startY);
    if (effort === press.effort) return;
    press.effort = effort;
    preview(press.button, effort);
  });

  container.addEventListener('pointerup', (event) => {
    if (press?.pointerId !== event.pointerId) return;
    const { button, startY } = press;
    clearPress();
    if (event.button === 0 && !button.disabled && !container.hidden) {
      launch(button, quickModelDragEffort(event.clientY - startY));
    }
  });

  for (const type of ['pointercancel', 'lostpointercapture']) {
    container.addEventListener(type, (event) => {
      if (press?.pointerId === event.pointerId) clearPress();
    });
  }
  container.addEventListener('contextmenu', clearPress);
  container.ownerDocument.defaultView.addEventListener('blur', clearPress);

  // Pointer activation is handled on release, even when it happens outside the button.
  container.addEventListener('click', (event) => {
    const button = modelButton(event);
    if (button && !press && event.detail === 0) launch(button, DEFAULT_EFFORT);
  });

  container.addEventListener('keydown', (event) => {
    if (press && event.key === 'Escape') {
      clearPress();
      return;
    }
    if (press || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const button = modelButton(event);
    if (!button || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    event.preventDefault();
    if (!event.repeat) launch(button, event.key === 'ArrowUp' ? 'high' : 'low');
  });
}
