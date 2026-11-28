import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setTheme, useTheme } from "@/lib/theme";

/** The top bar's light / dark switch. A toggle button: pressed means dark. */
export function ThemeToggle() {
  const dark = useTheme() === "dark";
  return (
    <Button
      type="button"
      size="icon"
      variant="outline"
      className="size-8 rounded-full"
      aria-label="Dark theme"
      aria-pressed={dark}
      title={dark ? "Switch to the light theme" : "Switch to the dark theme"}
      onClick={() => setTheme(dark ? "light" : "dark")}
    >
      {dark ? <Sun /> : <Moon />}
    </Button>
  );
}
