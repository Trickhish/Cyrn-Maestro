import { useEffect, useState } from "react";

/* Dark is the product's default, not the OS's — an orchestration console that
   flipped to light because someone's laptop did would be the wrong call. The
   choice is explicit and remembered. */

export type Theme = "dark" | "light";

const KEY = "maestro.theme";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(KEY);
    return stored === "light" ? "light" : "dark";
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(KEY, theme);
  }, [theme]);

  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}
