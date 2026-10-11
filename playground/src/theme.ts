/**
 * Light and dark themes. The choice lives in localStorage under one flag and
 * is mirrored onto <html data-theme>, which the stylesheet's token palettes
 * key on. index.html applies the flag before first paint; this module owns
 * every later change.
 */

export type Theme = 'light' | 'dark';

/** The localStorage flag. Values: 'light' or 'dark'. Absent means follow the OS. */
export const THEME_STORAGE_KEY = 'mattebox.playground.theme';

/** Fired on document when the theme changes, so canvases can re-read colors. */
export const THEME_EVENT = 'mattebox:theme';

function savedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_STORAGE_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function systemTheme(): Theme {
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

export function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' || attr === 'dark' ? attr : (savedTheme() ?? systemTheme());
}

export function setTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the
    // in-page toggle still works for the session.
  }
  document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
}

export function toggleTheme(): Theme {
  const next: Theme = currentTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  return next;
}

/** Reads a CSS custom property from :root, for canvas drawing that must follow the theme. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** The toggle's icons, the ones the website draws: a sun for light, a moon for dark. */
const SUN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const MOON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';

/** Wires the toggle button: applies the saved theme and keeps the icon and the label current. */
export function bindThemeToggle(button: HTMLElement): void {
  const paint = () => {
    const theme = currentTheme();
    // The icon shows the theme in use, and the label says what a press does.
    const dark = theme === 'dark';
    button.innerHTML = dark ? MOON : SUN;
    const label = `Colour scheme: ${dark ? 'dark' : 'light'}. Switch to ${dark ? 'light' : 'dark'}`;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
  };
  const saved = savedTheme();
  if (saved !== null) document.documentElement.setAttribute('data-theme', saved);
  button.addEventListener('click', () => {
    toggleTheme();
    paint();
  });
  // Follow the OS until the user picks explicitly.
  window.matchMedia?.('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (savedTheme() === null) {
      document.documentElement.setAttribute('data-theme', systemTheme());
      document.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme: systemTheme() } }));
      paint();
    }
  });
  paint();
}
