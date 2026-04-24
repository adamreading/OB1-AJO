"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface Theme {
  id: string;
  label: string;
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: "coal",
    label: "Coal (Default)",
    vars: {
      "--color-bg-primary": "#0a0a0f",
      "--color-bg-surface": "#111118",
      "--color-bg-elevated": "#1a1a24",
      "--color-bg-hover": "#222230",
      "--color-border": "#2a2a3a",
      "--color-border-subtle": "#1e1e2e",
      "--color-text-primary": "#e8e8ef",
      "--color-text-secondary": "#a8a8c0",
      "--color-text-muted": "#7878a0",
      "--color-violet": "#8b5cf6",
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    vars: {
      "--color-bg-primary": "#05050e",
      "--color-bg-surface": "#0d0d1f",
      "--color-bg-elevated": "#141428",
      "--color-bg-hover": "#1c1c34",
      "--color-border": "#242440",
      "--color-border-subtle": "#18183a",
      "--color-text-primary": "#e0e0ff",
      "--color-text-secondary": "#a0a0d0",
      "--color-text-muted": "#7070a8",
      "--color-violet": "#a78bfa",
    },
  },
  {
    id: "slate",
    label: "Slate",
    vars: {
      "--color-bg-primary": "#0c0f14",
      "--color-bg-surface": "#131820",
      "--color-bg-elevated": "#1a2030",
      "--color-bg-hover": "#222a3c",
      "--color-border": "#2a3448",
      "--color-border-subtle": "#1e2840",
      "--color-text-primary": "#dde4f0",
      "--color-text-secondary": "#9aaac4",
      "--color-text-muted": "#6a7a9c",
      "--color-violet": "#7c9ef8",
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    vars: {
      "--color-bg-primary": "#050e14",
      "--color-bg-surface": "#0a1820",
      "--color-bg-elevated": "#0f2030",
      "--color-bg-hover": "#142840",
      "--color-border": "#1a3450",
      "--color-border-subtle": "#122844",
      "--color-text-primary": "#d0eeff",
      "--color-text-secondary": "#8bbcd8",
      "--color-text-muted": "#5a8caa",
      "--color-violet": "#38bdf8",
    },
  },
  {
    id: "forest",
    label: "Forest",
    vars: {
      "--color-bg-primary": "#060e08",
      "--color-bg-surface": "#0d1810",
      "--color-bg-elevated": "#142018",
      "--color-bg-hover": "#1c2c20",
      "--color-border": "#243828",
      "--color-border-subtle": "#1a2c1e",
      "--color-text-primary": "#d4f0da",
      "--color-text-secondary": "#88b894",
      "--color-text-muted": "#5a8a65",
      "--color-violet": "#34d399",
    },
  },
];

const STORAGE_KEY = "ob-theme";

interface ThemeContextValue {
  theme: Theme;
  setTheme: (id: string) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: THEMES[0],
  setTheme: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeId] = useState<string>("coal");

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && THEMES.find((t) => t.id === saved)) {
      setThemeId(saved);
    }
  }, []);

  useEffect(() => {
    const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];
    const root = document.documentElement;
    for (const [key, value] of Object.entries(theme.vars)) {
      root.style.setProperty(key, value);
    }
  }, [themeId]);

  function setTheme(id: string) {
    setThemeId(id);
    localStorage.setItem(STORAGE_KEY, id);
  }

  const theme = THEMES.find((t) => t.id === themeId) ?? THEMES[0];

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
