import { afterEach, describe, expect, it } from "vitest";
import { initTheme, setTheme } from "@/lib/theme";

describe("theme", () => {
  afterEach(() => {
    window.localStorage.clear();
    initTheme();
  });

  it("is light until dark is chosen, and remembers the choice", () => {
    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    setTheme("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    document.documentElement.classList.remove("dark"); // a new page load
    initTheme();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    setTheme("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
