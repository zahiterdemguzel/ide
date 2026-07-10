console.log('[perf-mod] +'+Math.round(performance.now())+'ms eval onboarding/index.js'); // PERF-TEMP
// Onboarding entry point.
//
// initOnboarding() wires the always-available help (cheat sheet, F1/?, the
// welcome "Take the tour" button) immediately. The entry tutorial — the guided
// tour — is deferred to activateOnboarding(), which the caller runs only once
// Claude Code is confirmed installed (past the setup gate).
import { startTour } from './tour.js';
import { openCheatSheet, initCheatSheet } from './cheatsheet.js';
import { isTourDone, loadOnboardingState } from './state.js';

export { startTour, openCheatSheet };

// Manual entry points — safe to wire before Claude Code exists.
export function initOnboarding() {
  initCheatSheet();
  document.getElementById('welcome-tour')?.addEventListener('click', startTour);
}

// The guided tour auto-runs once (its own persisted tour-done flag), gated on
// Claude Code being installed and a project being open so its steps point at real
// UI. The flag is loaded from the main process first so a returning user — whose
// flag survives the per-instance profile wipe — never sees it again.
export async function activateOnboarding({ hasRepo } = {}) {
  await loadOnboardingState();
  if (hasRepo && !isTourDone()) {
    // Defer one frame so the layout has settled and every target has a real rect.
    requestAnimationFrame(startTour);
  }
}
