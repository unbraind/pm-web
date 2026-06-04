// ═══════════════════════════════════════════════════════════════
// THEME — dark / light / auto, persisted to localStorage
// ═══════════════════════════════════════════════════════════════
//
// The palette lives in CSS variables (styles.css). This module only toggles
// the `data-theme` attribute on <html> and persists the choice. "auto" defers
// to the OS via the prefers-color-scheme media query. Default (no stored
// preference) is "auto", matching the data-theme="auto" attribute in the HTML
// shell so there is no flash of the wrong theme on load.

export type Theme = 'dark' | 'light' | 'auto';

const STORAGE_KEY = 'pm-web-theme';
const ORDER: Theme[] = ['auto', 'light', 'dark'];

// Glyph shown on the toggle button per active theme.
const GLYPH: Record<Theme, string> = {
  auto: '◐',
  light: '☀',
  dark: '☾',
};

const LABEL: Record<Theme, string> = {
  auto: 'Theme: auto (follows system)',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

export function getStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'dark' || v === 'light' || v === 'auto') return v;
  } catch { /* localStorage may be unavailable (private mode) */ }
  return 'auto';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    btn.textContent = GLYPH[theme];
    btn.title = LABEL[theme];
    btn.setAttribute('aria-label', LABEL[theme]);
  }
  // Keep the mobile browser chrome color in step with the active theme.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const dark = '#0a0f1e';
    const light = '#f6f8fc';
    let color = dark;
    if (theme === 'light') color = light;
    else if (theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: light)').matches) color = light;
    meta.setAttribute('content', color);
  }
}

export function setTheme(theme: Theme): void {
  try { localStorage.setItem(STORAGE_KEY, theme); } catch { /* ignore */ }
  applyTheme(theme);
}

export function cycleTheme(): void {
  const current = getStoredTheme();
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  setTheme(next);
}

// Apply the persisted (or default) theme as early as possible.
export function initTheme(): void {
  applyTheme(getStoredTheme());
  // When in auto mode, react to live OS theme changes.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
    if (getStoredTheme() === 'auto') applyTheme('auto');
  });
}
