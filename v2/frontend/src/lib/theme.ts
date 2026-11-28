import { useSyncExternalStore } from "react";

/** Light or dark, chosen with the switch in the top bar and remembered on this device. Dark is the `.dark` class on
 *  <html>: `dark.css` remaps the colours under it, so no component needs to know. Light until someone chooses. */
export type Theme = "light" | "dark";

const KEY = "dt.theme";
const listeners = new Set<() => void>();

function stored(): Theme {
  try {
    return window.localStorage.getItem(KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light"; // storage blocked: the default
  }
}

let current: Theme = "light";

function apply(theme: Theme) {
  current = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

/** Before the first render, so the page does not flash light. */
export function initTheme() {
  apply(stored());
}

export function setTheme(theme: Theme) {
  apply(theme);
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // not remembered; still applied for this visit
  }
  listeners.forEach((listener) => listener());
}

export function useTheme(): Theme {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

/** The brand blue as a hex, for the charts and tiles that need a plain colour value (they add an alpha to it):
 *  the deep blue on light, the bright blue on dark. Everything else uses the `brand` classes. */
export function useBrandHex(): string {
  return useTheme() === "dark" ? "#009DDA" : "#034EA1";
}
