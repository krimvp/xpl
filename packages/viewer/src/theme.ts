/**
 * Light or dark. The reader picks Auto (follow the device), Light or Dark with the header's theme button; the
 * choice is kept in this browser (localStorage, per page origin) and Auto is the default. The page's colours
 * come from the tokens in styles.css: the dark ones apply under `<html data-theme="dark">`, which `applyTheme`
 * sets before the first render (and again when the device switches while the choice is Auto).
 */
export type ThemeChoice = "auto" | "light" | "dark";
type Theme = "light" | "dark";

const KEY = "xpl-theme";
const DARK = "(prefers-color-scheme: dark)";
/** The choice made on this page (it outlives blocked storage until the page closes). */
let chosen: ThemeChoice | undefined;

/** The button's cycle: Auto, then Light, then Dark, then Auto again. */
export const NEXT_THEME: Record<ThemeChoice, ThemeChoice> = {
  auto: "light",
  light: "dark",
  dark: "auto",
};

function resolveTheme(choice: ThemeChoice, deviceDark: boolean): Theme {
  return choice === "auto" ? (deviceDark ? "dark" : "light") : choice;
}

/** The reader's choice in this browser; Auto when none was made or storage cannot be read. */
export function themeChoice(): ThemeChoice {
  if (chosen) return chosen;
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    // storage blocked: Auto
  }
  return "auto";
}

const deviceDark = () => typeof matchMedia === "function" && matchMedia(DARK).matches;

/** Sets the page's theme for `choice` (default: the stored one) and returns it. */
function applyTheme(choice: ThemeChoice = themeChoice()): Theme {
  const theme = resolveTheme(choice, deviceDark());
  document.documentElement.dataset.theme = theme;
  return theme;
}

/** Keeps the choice in this browser and applies it. */
export function setThemeChoice(choice: ThemeChoice): void {
  chosen = choice;
  try {
    if (choice === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // storage blocked: the choice lasts until the page is closed
  }
  applyTheme(choice);
}

/** Applies the stored choice now, and follows the device while the choice is Auto. */
export function installTheme(): void {
  applyTheme();
  if (typeof matchMedia !== "function") return;
  matchMedia(DARK).addEventListener("change", () => {
    if (themeChoice() === "auto") applyTheme("auto");
  });
}
