// Onboarding persistence. The flag lives in a main-process file (via IPC), NOT
// localStorage: the default session's storage is wiped on every quit by the
// per-instance profile cleanup, which would make the tour re-run every launch.
// See src/main/onboarding-store.js.
//
// The flag is fetched once (loadOnboardingState) and cached so isTourDone() can
// stay synchronous for the callers that gate on it.
let tourDone = false;

export async function loadOnboardingState() {
  try {
    const s = await window.api.onboardingGet();
    tourDone = !!(s && s.tourDone);
  } catch {
    tourDone = false;
  }
  return tourDone;
}

export function isTourDone() {
  return tourDone;
}

export function setTourDone() {
  tourDone = true;
  window.api.onboardingSetTourDone?.();
}

// Clear the flag so the tour auto-runs again — backs the "replay" entries and is
// handy for testing.
export function resetOnboarding() {
  tourDone = false;
  window.api.onboardingReset?.();
}
