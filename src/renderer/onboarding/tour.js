// The guided tour: a spotlight overlay that walks a first-time user through the
// app's regions. A dim full-screen scrim has a transparent cutout over the
// current step's target (a box-shadow "hole"), and a coach-mark card explains
// it with Back / Next / Skip controls. Geometry is recomputed on resize. The
// step list and bubble placement come from the pure onboarding-lib.
import { TOUR_STEPS, placeBubble } from '../shared/onboarding-lib.js';
import { t } from '../../i18n/index.js';
import { setTourDone } from './state.js';

let overlay = null;     // root scrim, or null when the tour is closed
let spotlight = null;   // the cutout element
let card = null;        // the coach-mark
let steps = [];         // visible steps for this run
let index = 0;
let onKey = null;
let onResize = null;

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function visibleSteps() {
  return TOUR_STEPS.filter((s) => isVisible(document.querySelector(s.target)));
}

function build() {
  overlay = document.createElement('div');
  overlay.className = 'onboarding-overlay';
  // A click on the scrim (outside the card) ends the tour, like Skip.
  overlay.addEventListener('click', (e) => { if (e.target === overlay || e.target === spotlight) finish(); });

  spotlight = document.createElement('div');
  spotlight.className = 'onboarding-spotlight';
  overlay.appendChild(spotlight);

  card = document.createElement('div');
  card.className = 'onboarding-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  overlay.appendChild(card);

  document.body.appendChild(overlay);

  onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
  };
  window.addEventListener('keydown', onKey, true);
  onResize = () => layout();
  window.addEventListener('resize', onResize);
}

function render() {
  const step = steps[index];
  const last = index === steps.length - 1;
  card.replaceChildren();

  const counter = document.createElement('div');
  counter.className = 'onboarding-counter';
  counter.textContent = `${index + 1} / ${steps.length}`;

  const title = document.createElement('h3');
  title.className = 'onboarding-title';
  title.textContent = t(step.titleKey);

  const body = document.createElement('p');
  body.className = 'onboarding-body';
  body.textContent = t(step.bodyKey);

  const actions = document.createElement('div');
  actions.className = 'onboarding-actions';

  const skip = document.createElement('button');
  skip.className = 'onboarding-btn onboarding-skip';
  skip.textContent = t('tour.skip');
  skip.onclick = finish;

  const spacer = document.createElement('span');
  spacer.className = 'onboarding-spacer';

  const back = document.createElement('button');
  back.className = 'onboarding-btn';
  back.textContent = t('tour.back');
  back.disabled = index === 0;
  back.onclick = prev;

  const fwd = document.createElement('button');
  fwd.className = 'onboarding-btn onboarding-primary';
  fwd.textContent = last ? t('tour.finish') : t('tour.next');
  fwd.onclick = last ? finish : next;

  actions.append(skip, spacer, back, fwd);
  card.append(counter, title, body, actions);
  layout();
  fwd.focus();
}

function layout() {
  const step = steps[index];
  const el = document.querySelector(step.target);
  if (!isVisible(el)) { finish(); return; }
  const r = el.getBoundingClientRect();
  const pad = 6;
  spotlight.style.left = `${Math.round(r.left - pad)}px`;
  spotlight.style.top = `${Math.round(r.top - pad)}px`;
  spotlight.style.width = `${Math.round(r.width + pad * 2)}px`;
  spotlight.style.height = `${Math.round(r.height + pad * 2)}px`;

  const anchor = {
    top: r.top - pad, left: r.left - pad,
    width: r.width + pad * 2, height: r.height + pad * 2,
    bottom: r.bottom + pad,
  };
  const size = { width: card.offsetWidth, height: card.offsetHeight };
  const p = placeBubble(anchor, size, { width: window.innerWidth, height: window.innerHeight });
  card.style.left = `${p.left}px`;
  card.style.top = `${p.top}px`;
  card.classList.remove('onboarding-card-top', 'onboarding-card-bottom', 'onboarding-card-left', 'onboarding-card-right');
  card.classList.add(`onboarding-card-${p.placement}`);
  card.style.setProperty('--onboarding-tail', `${p.tail}px`);
}

function next() { if (index < steps.length - 1) { index += 1; render(); } }
function prev() { if (index > 0) { index -= 1; render(); } }

function finish() {
  setTourDone();
  if (onKey) window.removeEventListener('keydown', onKey, true);
  if (onResize) window.removeEventListener('resize', onResize);
  onKey = onResize = null;
  overlay?.remove();
  overlay = spotlight = card = null;
}

// Start (or restart) the tour. A second call while one is open is a no-op so a
// double trigger (welcome button + first-run) can't stack two overlays.
export function startTour() {
  if (overlay) return;
  steps = visibleSteps();
  if (!steps.length) return;
  // Mark it seen as soon as it actually shows, not just on Finish/Skip — so
  // quitting mid-tour still counts and it never auto-runs a second time.
  setTourDone();
  index = 0;
  build();
  render();
}
