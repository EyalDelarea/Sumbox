// ── Theme resolution + apply (light מרווה / dark לילה) ───
//
// Pure resolution is unit-tested; the DOM/storage helpers are thin wrappers
// kept side-effect-isolated so the same module can boot the app and back the
// בהיר/כהה toggle.

export const THEME_KEY = "sumbox-theme";

/**
 * Resolve the theme to apply on load.
 * An explicit stored choice wins; otherwise follow the OS preference;
 * unknown/empty falls back to the OS preference (light when absent).
 *
 * @param {string|null} stored - persisted choice ("light" | "dark" | null)
 * @param {boolean} prefersDark - `prefers-color-scheme: dark` match
 * @returns {"light"|"dark"}
 */
export function resolveInitialTheme(stored, prefersDark) {
  if (stored === "light" || stored === "dark") return stored;
  return prefersDark ? "dark" : "light";
}

/** Reflect the theme onto the document root (dark = attribute present). */
export function applyTheme(value, root = document.documentElement) {
  if (value === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

/** Read the persisted choice, tolerating disabled storage (private mode). */
export function readStoredTheme(store = localStorage) {
  try {
    return store.getItem(THEME_KEY);
  } catch {
    return null;
  }
}

/** Apply and persist an explicit choice. */
export function setTheme(value, root = document.documentElement, store = localStorage) {
  applyTheme(value, root);
  try {
    store.setItem(THEME_KEY, value);
  } catch {
    /* storage unavailable — apply still took effect for this session */
  }
}
