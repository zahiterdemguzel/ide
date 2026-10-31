// Settings dialog navigation: the sidebar switches between pages, and the search
// box filters every page at once — pages, groups and rows that don't match hide,
// and a page whose own title matches stays whole. The matching rules live in the
// DOM-free shared/settings-search.js.

import { searchTerms, matchesSearch } from './shared/settings-search.js';

const LAST_PAGE_KEY = 'ide.settingsPage';
// What counts as one searchable setting: a value row, a switch, or a block that
// opts in (the theme cards).
const ITEM_SELECTOR = '.settings-row, .panel-toggle, [data-search-item]';

// A row is found by its label (and description), not by its control: a select's
// option list would make "on" or "en" match half the dialog.
function searchableText(item) {
  const label = item.matches('[data-search-item]') ? item : item.firstElementChild;
  return `${label?.textContent || ''} ${item.title}`;
}

function readLastPage() {
  try { return localStorage.getItem(LAST_PAGE_KEY); } catch { return null; }
}

export function initSettingsNav() {
  const dialog = document.getElementById('settings-dialog');
  const body = dialog.querySelector('.settings-body');
  const searchInput = document.getElementById('settings-search');
  const noResults = document.getElementById('settings-no-results');
  const navItems = [...dialog.querySelectorAll('.settings-nav-item')];
  const pages = [...dialog.querySelectorAll('.settings-page')];
  const pageById = new Map(pages.map((page) => [page.dataset.page, page]));

  let activePage = pageById.has(readLastPage()) ? readLastPage() : pages[0].dataset.page;

  const showPage = (id) => {
    activePage = id;
    for (const page of pages) page.classList.toggle('is-active', page.dataset.page === id);
    for (const item of navItems) {
      const selected = item.dataset.page === id;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    body.scrollTop = 0;
    localStorage.setItem(LAST_PAGE_KEY, id);
  };

  // A row is hidden when it misses; a group hides when it has rows and none of
  // them matched (groups without rows — the QR, the model catalog — hide whenever
  // their page is only partly matched, since there's nothing in them to search).
  const applySearch = () => {
    const terms = searchTerms(searchInput.value);
    const searching = terms.length > 0;
    dialog.classList.toggle('is-searching', searching);
    let anyMatch = false;

    for (const page of pages) {
      const titleText = page.querySelector('.settings-page-head h2')?.textContent || '';
      const wholePage = searching && matchesSearch(titleText, terms);
      let pageHits = 0;
      for (const item of page.querySelectorAll(ITEM_SELECTOR)) {
        const hit = !searching || wholePage || matchesSearch(searchableText(item), terms);
        item.classList.toggle('search-miss', !hit);
        if (hit) pageHits += 1;
      }
      for (const group of page.querySelectorAll('.settings-group')) {
        const items = group.querySelectorAll(ITEM_SELECTOR);
        const visible = [...items].some((item) => !item.classList.contains('search-miss'));
        const groupMiss = searching && !wholePage && (items.length ? !visible : true);
        group.classList.toggle('search-miss', groupMiss);
      }
      const pageMatches = wholePage || pageHits > 0;
      page.classList.toggle('search-hit', searching && pageMatches);
      if (pageMatches) anyMatch = true;
      const navItem = navItems.find((item) => item.dataset.page === page.dataset.page);
      navItem?.classList.toggle('search-dim', searching && !pageMatches);
    }
    noResults.hidden = !searching || anyMatch;
    if (searching) body.scrollTop = 0;
  };

  const clearSearch = () => {
    if (!searchInput.value) return;
    searchInput.value = '';
    applySearch();
  };

  for (const item of navItems) {
    item.onclick = () => {
      clearSearch();
      showPage(item.dataset.page);
    };
  }

  // Arrow keys move through the page list like a vertical tab strip.
  dialog.querySelector('.settings-nav-list').addEventListener('keydown', (event) => {
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
    const edge = { Home: 0, End: navItems.length - 1 }[event.key];
    if (step === undefined && edge === undefined) return;
    event.preventDefault();
    const current = navItems.findIndex((item) => item.dataset.page === activePage);
    const next = edge ?? (current + step + navItems.length) % navItems.length;
    navItems[next].click();
    navItems[next].focus();
  });

  searchInput.addEventListener('input', applySearch);
  // Escape empties a filled search box first; only an empty one closes the dialog.
  searchInput.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && searchInput.value) {
      event.preventDefault();
      clearSearch();
    }
  });
  dialog.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }
  });

  showPage(activePage);

  // Each time the dialog opens it starts unfiltered, on the page last viewed.
  return function resetSettingsNav() {
    clearSearch();
    showPage(activePage);
  };
}
