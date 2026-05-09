"use client";

import { createContext, useContext, useEffect, useState } from "react";

export interface Theme {
  id: string;
  label: string;
  /** Whether this theme is light- or dark-scheme — drives `color-scheme`. */
  scheme: "dark" | "light";
  /** Legacy --color-* tokens (used by Wiki List view, Actions, Review, etc.). */
  vars: Record<string, string>;
  /** OB1 design tokens (used by Dashboard, Thoughts, Workflow, Wiki Graph, Sidebar). */
  designVars: Record<string, string>;
}

// Shared violet/status palette — themes only swap surfaces & text.
const VIOLET = {
  "--violet-50": "#f3f0ff",
  "--violet-200": "#d4c8ff",
  "--violet-300": "#b8a6ff",
  "--violet-400": "#9d83ff",
  "--violet-500": "#8261ff",
  "--violet-600": "#6b46e5",
  "--violet-700": "#553aba",
};

export const THEMES: Theme[] = [
  {
    id: "coal",
    label: "Coal (Default)",
    scheme: "dark",
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
    designVars: {
      "--bg-0": "#07070a",
      "--bg-1": "#0c0c12",
      "--bg-2": "#11111a",
      "--bg-3": "#171724",
      "--bg-4": "#1e1e2d",
      "--line": "rgba(255,255,255,0.06)",
      "--line-strong": "rgba(255,255,255,0.10)",
      "--fg": "#f4f4f7",
      "--fg-2": "#c5c5d2",
      "--fg-3": "#8a8a9b",
      "--fg-4": "#5a5a6e",
      ...VIOLET,
    },
  },
  {
    id: "midnight",
    label: "Midnight",
    scheme: "dark",
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
    designVars: {
      "--bg-0": "#04040c",
      "--bg-1": "#08081a",
      "--bg-2": "#0e0e22",
      "--bg-3": "#15153a",
      "--bg-4": "#1d1d50",
      "--line": "rgba(180,180,255,0.07)",
      "--line-strong": "rgba(180,180,255,0.12)",
      "--fg": "#f0f0ff",
      "--fg-2": "#c4c4e2",
      "--fg-3": "#8c8cb6",
      "--fg-4": "#5a5a8a",
      ...VIOLET,
    },
  },
  {
    id: "slate",
    label: "Slate",
    scheme: "dark",
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
    designVars: {
      "--bg-0": "#0a0d12",
      "--bg-1": "#0f1320",
      "--bg-2": "#161b2a",
      "--bg-3": "#1f2538",
      "--bg-4": "#2a324a",
      "--line": "rgba(180,200,230,0.07)",
      "--line-strong": "rgba(180,200,230,0.12)",
      "--fg": "#e6edf5",
      "--fg-2": "#b0bccd",
      "--fg-3": "#7888a0",
      "--fg-4": "#4d5a6a",
      ...VIOLET,
    },
  },
  {
    id: "ocean",
    label: "Ocean",
    scheme: "dark",
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
    designVars: {
      "--bg-0": "#04101c",
      "--bg-1": "#06182a",
      "--bg-2": "#0c2438",
      "--bg-3": "#14304a",
      "--bg-4": "#1c4060",
      "--line": "rgba(150,210,255,0.07)",
      "--line-strong": "rgba(150,210,255,0.12)",
      "--fg": "#dcf0ff",
      "--fg-2": "#a0c8e0",
      "--fg-3": "#6c95b6",
      "--fg-4": "#446680",
      ...VIOLET,
    },
  },
  {
    id: "forest",
    label: "Forest",
    scheme: "dark",
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
    designVars: {
      "--bg-0": "#050d09",
      "--bg-1": "#08160e",
      "--bg-2": "#0d2018",
      "--bg-3": "#163024",
      "--bg-4": "#20402c",
      "--line": "rgba(150,220,170,0.07)",
      "--line-strong": "rgba(150,220,170,0.12)",
      "--fg": "#dcf0e2",
      "--fg-2": "#a0c5a8",
      "--fg-3": "#6c8c74",
      "--fg-4": "#446050",
      ...VIOLET,
    },
  },
  {
    id: "light",
    label: "Light",
    scheme: "light",
    vars: {
      "--color-bg-primary": "#fafafb",
      "--color-bg-surface": "#ffffff",
      "--color-bg-elevated": "#f3f3f7",
      "--color-bg-hover": "#eaeaf0",
      "--color-border": "#dcdce4",
      "--color-border-subtle": "#ebebef",
      "--color-text-primary": "#1a1a26",
      "--color-text-secondary": "#4a4a5e",
      "--color-text-muted": "#7a7a8e",
      "--color-violet": "#7c3aed",
    },
    designVars: {
      "--bg-0": "#fafafb",
      "--bg-1": "#f4f4f8",
      "--bg-2": "#ffffff",
      "--bg-3": "#f0f0f5",
      "--bg-4": "#e6e6ed",
      "--line": "rgba(0,0,0,0.08)",
      "--line-strong": "rgba(0,0,0,0.14)",
      "--fg": "#1a1a26",
      "--fg-2": "#3a3a4e",
      "--fg-3": "#6a6a80",
      "--fg-4": "#9a9aa8",
      ...VIOLET,
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
    for (const [key, value] of Object.entries(theme.designVars)) {
      root.style.setProperty(key, value);
    }
    root.style.setProperty("color-scheme", theme.scheme);
    root.dataset.themeScheme = theme.scheme;
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
