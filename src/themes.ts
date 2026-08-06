/**
 * Color themes: terminal palettes (xterm ITheme) + UI colors (sidebar, tabs,
 * modals, search bar) + a dockview base theme per color scheme.
 *
 * The UI colors are exposed as CSS custom properties (`--hf-*`) on `:root`
 * (set from JS when the active theme changes) and the dockview chrome reads
 * them through the shared `.dockview-theme-hivefield` override class. The
 * terminal palette is pushed into each xterm's `options.theme` so every
 * session updates live when the theme setting changes.
 */

import type { ITheme } from "@xterm/xterm";
import {
  themeAbyss,
  themeCatppuccinMocha,
  themeDark,
  themeDracula,
  themeGithubDark,
  themeGithubLight,
  themeLight,
  themeMonokai,
  themeNord,
  themeSolarizedLight,
  type DockviewTheme,
} from "dockview";

export type ColorScheme = "light" | "dark";

/** UI chrome colors (sidebar, tabs, modals, search bar, badges). */
export interface HiveThemeColors {
  /** Window / app background (also dockview group view). */
  base: string;
  /** Sidebar and tab-strip background. */
  mantle: string;
  /** Deepest background (inactive-group tabs, modals). */
  crust: string;
  /** Card / active-tab background. */
  surface0: string;
  /** Hover background. */
  surface1: string;
  /** Borders / separators. */
  surface2: string;
  /** Primary text. */
  text: string;
  /** Secondary text. */
  subtext1: string;
  /** Tertiary text. */
  subtext0: string;
  /** Muted text (section titles, placeholders, icons). */
  overlay0: string;
  /** Accent color (focus borders, active highlights). */
  accent: string;
  /** Foreground color that reads on top of the accent. */
  accentFg: string;
  green: string;
  red: string;
  yellow: string;
  teal: string;
}

export interface HiveTheme {
  id: string;
  name: string;
  colorScheme: ColorScheme;
  /** Base dockview theme providing the structural chrome; colors are overridden. */
  dockview: DockviewTheme;
  /** The 16-color terminal palette + cursor/background. */
  terminal: ITheme;
  ui: HiveThemeColors;
}

function makeTerminal(
  background: string,
  foreground: string,
  cursor: string,
  black: string,
  red: string,
  green: string,
  yellow: string,
  blue: string,
  magenta: string,
  cyan: string,
  white: string,
  brightBlack: string,
  brightRed: string,
  brightGreen: string,
  brightYellow: string,
  brightBlue: string,
  brightMagenta: string,
  brightCyan: string,
  brightWhite: string,
  selectionBackground?: string
): ITheme {
  return {
    background,
    foreground,
    cursor,
    cursorAccent: background,
    selectionBackground: selectionBackground ?? `${foreground}33`,
    black,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white,
    brightBlack,
    brightRed,
    brightGreen,
    brightYellow,
    brightBlue,
    brightMagenta,
    brightCyan,
    brightWhite,
  };
}

/** Compose a dockview theme that inherits a base theme's chrome + our overrides. */
function makeDockview(base: DockviewTheme): DockviewTheme {
  return {
    ...base,
    name: `hivefield-${base.name}`,
    className: `${base.className} dockview-theme-hivefield`,
  };
}

/* ---------------------------------------------------------------------------
 * Catppuccin Mocha (default)
 * ------------------------------------------------------------------------- */

const catppuccinMocha: HiveTheme = {
  id: "catppuccin-mocha",
  name: "Catppuccin Mocha",
  colorScheme: "dark",
  dockview: makeDockview(themeCatppuccinMocha),
  terminal: makeTerminal(
    "#1e1e2e", "#cdd6f4", "#f5e0dc",
    "#45475a", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa",
    "#cba6f7", "#94e2d5", "#bac2de",
    "#585b70", "#f38ba8", "#a6e3a1", "#f9e2af", "#89b4fa",
    "#cba6f7", "#94e2d5", "#a6adc8"
  ),
  ui: {
    base: "#1e1e2e", mantle: "#181825", crust: "#11111b",
    surface0: "#313244", surface1: "#45475a", surface2: "#45475a",
    text: "#cdd6f4", subtext1: "#bac2de", subtext0: "#a6adc8", overlay0: "#6c7086",
    accent: "#89b4fa", accentFg: "#11111b",
    green: "#a6e3a1", red: "#f38ba8", yellow: "#f9e2af", teal: "#94e2d5",
  },
};

/* ---------------------------------------------------------------------------
 * Catppuccin Latte (light)
 * ------------------------------------------------------------------------- */

const catppuccinLatte: HiveTheme = {
  id: "catppuccin-latte",
  name: "Catppuccin Latte",
  colorScheme: "light",
  dockview: makeDockview(themeLight),
  terminal: makeTerminal(
    "#eff1f5", "#4c4f69", "#dc8a78",
    "#5c5f77", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5",
    "#ea76cb", "#179299", "#acb0be",
    "#6c6f85", "#d20f39", "#40a02b", "#df8e1d", "#1e66f5",
    "#ea76cb", "#179299", "#bcc0cc"
  ),
  ui: {
    base: "#eff1f5", mantle: "#e6e9ef", crust: "#dce0e8",
    surface0: "#ccd0da", surface1: "#bcc0cc", surface2: "#bcc0cc",
    text: "#4c4f69", subtext1: "#5c5f77", subtext0: "#6c6f85", overlay0: "#8c8fa1",
    accent: "#1e66f5", accentFg: "#eff1f5",
    green: "#40a02b", red: "#d20f39", yellow: "#df8e1d", teal: "#179299",
  },
};

/* ---------------------------------------------------------------------------
 * Nord
 * ------------------------------------------------------------------------- */

const nord: HiveTheme = {
  id: "nord",
  name: "Nord",
  colorScheme: "dark",
  dockview: makeDockview(themeNord),
  terminal: makeTerminal(
    "#2e3440", "#d8dee9", "#d8dee9",
    "#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1",
    "#b48ead", "#88c0d0", "#e5e9f0",
    "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1",
    "#b48ead", "#8fbcbb", "#eceff4"
  ),
  ui: {
    base: "#2e3440", mantle: "#272c36", crust: "#1f232b",
    surface0: "#3b4252", surface1: "#434c5e", surface2: "#4c566a",
    text: "#d8dee9", subtext1: "#e5e9f0", subtext0: "#d8dee9", overlay0: "#616e88",
    accent: "#81a1c1", accentFg: "#2e3440",
    green: "#a3be8c", red: "#bf616a", yellow: "#ebcb8b", teal: "#88c0d0",
  },
};

/* ---------------------------------------------------------------------------
 * Dracula
 * ------------------------------------------------------------------------- */

const dracula: HiveTheme = {
  id: "dracula",
  name: "Dracula",
  colorScheme: "dark",
  dockview: makeDockview(themeDracula),
  terminal: makeTerminal(
    "#282a36", "#f8f8f2", "#f8f8f2",
    "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9",
    "#ff79c6", "#8be9fd", "#f8f8f2",
    "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff",
    "#ff92df", "#a4ffff", "#ffffff"
  ),
  ui: {
    base: "#282a36", mantle: "#21222c", crust: "#191a21",
    surface0: "#343746", surface1: "#424450", surface2: "#44475a",
    text: "#f8f8f2", subtext1: "#f8f8f2", subtext0: "#bfbfbf", overlay0: "#6272a4",
    accent: "#bd93f9", accentFg: "#282a36",
    green: "#50fa7b", red: "#ff5555", yellow: "#f1fa8c", teal: "#8be9fd",
  },
};

/* ---------------------------------------------------------------------------
 * Monokai
 * ------------------------------------------------------------------------- */

const monokai: HiveTheme = {
  id: "monokai",
  name: "Monokai",
  colorScheme: "dark",
  dockview: makeDockview(themeMonokai),
  terminal: makeTerminal(
    "#272822", "#f8f8f2", "#f8f8f2",
    "#272822", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef",
    "#ae81ff", "#a1efe4", "#f8f8f2",
    "#75715e", "#f92672", "#a6e22e", "#f4bf75", "#66d9ef",
    "#ae81ff", "#a1efe4", "#f9f8f5"
  ),
  ui: {
    base: "#272822", mantle: "#1e1f1c", crust: "#171814",
    surface0: "#34352f", surface1: "#3e3d32", surface2: "#49483e",
    text: "#f8f8f2", subtext1: "#f8f8f2", subtext0: "#cfcfc2", overlay0: "#75715e",
    accent: "#66d9ef", accentFg: "#272822",
    green: "#a6e22e", red: "#f92672", yellow: "#f4bf75", teal: "#a1efe4",
  },
};

/* ---------------------------------------------------------------------------
 * One Dark
 * ------------------------------------------------------------------------- */

const oneDark: HiveTheme = {
  id: "one-dark",
  name: "One Dark",
  colorScheme: "dark",
  dockview: makeDockview(themeDark),
  terminal: makeTerminal(
    "#282c34", "#abb2bf", "#528bff",
    "#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef",
    "#c678dd", "#56b6c2", "#abb2bf",
    "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef",
    "#c678dd", "#56b6c2", "#ffffff"
  ),
  ui: {
    base: "#282c34", mantle: "#21252b", crust: "#1b1e23",
    surface0: "#2f343d", surface1: "#353b45", surface2: "#3e4451",
    text: "#abb2bf", subtext1: "#abb2bf", subtext0: "#9da5b4", overlay0: "#5c6370",
    accent: "#61afef", accentFg: "#1b1e23",
    green: "#98c379", red: "#e06c75", yellow: "#e5c07b", teal: "#56b6c2",
  },
};

/* ---------------------------------------------------------------------------
 * Gruvbox Dark
 * ------------------------------------------------------------------------- */

const gruvboxDark: HiveTheme = {
  id: "gruvbox-dark",
  name: "Gruvbox Dark",
  colorScheme: "dark",
  dockview: makeDockview(themeDark),
  terminal: makeTerminal(
    "#282828", "#ebdbb2", "#ebdbb2",
    "#282828", "#cc241d", "#98971a", "#d79921", "#458588",
    "#b16286", "#689d6a", "#a89984",
    "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598",
    "#d3869b", "#8ec07c", "#ebdbb2"
  ),
  ui: {
    base: "#282828", mantle: "#1d2021", crust: "#141617",
    surface0: "#3c3836", surface1: "#504945", surface2: "#665c54",
    text: "#ebdbb2", subtext1: "#ebdbb2", subtext0: "#d5c4a1", overlay0: "#928374",
    accent: "#83a598", accentFg: "#1d2021",
    green: "#b8bb26", red: "#fb4934", yellow: "#fabd2f", teal: "#8ec07c",
  },
};

/* ---------------------------------------------------------------------------
 * Solarized Light
 * ------------------------------------------------------------------------- */

const solarizedLight: HiveTheme = {
  id: "solarized-light",
  name: "Solarized Light",
  colorScheme: "light",
  dockview: makeDockview(themeSolarizedLight),
  terminal: makeTerminal(
    "#fdf6e3", "#657b83", "#657b83",
    "#073642", "#dc322f", "#859900", "#b58900", "#268bd2",
    "#d33682", "#2aa198", "#eee8d5",
    "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496",
    "#6c71c4", "#93a1a1", "#fdf6e3"
  ),
  ui: {
    base: "#fdf6e3", mantle: "#eee8d5", crust: "#e8e2cf",
    surface0: "#eee8d5", surface1: "#e4ddc8", surface2: "#d5ccba",
    text: "#657b83", subtext1: "#586e75", subtext0: "#657b83", overlay0: "#93a1a1",
    accent: "#268bd2", accentFg: "#fdf6e3",
    green: "#859900", red: "#dc322f", yellow: "#b58900", teal: "#2aa198",
  },
};

/* ---------------------------------------------------------------------------
 * GitHub Dark / Light
 * ------------------------------------------------------------------------- */

const githubDark: HiveTheme = {
  id: "github-dark",
  name: "GitHub Dark",
  colorScheme: "dark",
  dockview: makeDockview(themeGithubDark),
  terminal: makeTerminal(
    "#0d1117", "#e6edf3", "#e6edf3",
    "#484f58", "#ff7b72", "#3fb950", "#d29922", "#58a6ff",
    "#bc8cff", "#39c5cf", "#b1bac4",
    "#6e7681", "#ffa198", "#56d364", "#e3b341", "#79c0ff",
    "#d2a8ff", "#56d4dd", "#f0f6fc"
  ),
  ui: {
    base: "#0d1117", mantle: "#010409", crust: "#010409",
    surface0: "#161b22", surface1: "#21262d", surface2: "#30363d",
    text: "#e6edf3", subtext1: "#e6edf3", subtext0: "#c9d1d9", overlay0: "#8b949e",
    accent: "#58a6ff", accentFg: "#0d1117",
    green: "#3fb950", red: "#ff7b72", yellow: "#d29922", teal: "#39c5cf",
  },
};

const githubLight: HiveTheme = {
  id: "github-light",
  name: "GitHub Light",
  colorScheme: "light",
  dockview: makeDockview(themeGithubLight),
  terminal: makeTerminal(
    "#ffffff", "#1f2328", "#1f2328",
    "#1f2328", "#cf222e", "#1a7f37", "#9a6700", "#0969da",
    "#8250df", "#1b7c83", "#6e7781",
    "#57606a", "#a40e26", "#1a7f37", "#633c01", "#0969da",
    "#8250df", "#1b7c83", "#ffffff"
  ),
  ui: {
    base: "#ffffff", mantle: "#f6f8fa", crust: "#eaeef2",
    surface0: "#f6f8fa", surface1: "#eaeef2", surface2: "#d0d7de",
    text: "#1f2328", subtext1: "#24292f", subtext0: "#57606a", overlay0: "#8c959f",
    accent: "#0969da", accentFg: "#ffffff",
    green: "#1a7f37", red: "#cf222e", yellow: "#9a6700", teal: "#1b7c83",
  },
};

/* ---------------------------------------------------------------------------
 * Abyss
 * ------------------------------------------------------------------------- */

const abyss: HiveTheme = {
  id: "abyss",
  name: "Abyss",
  colorScheme: "dark",
  dockview: makeDockview(themeAbyss),
  terminal: makeTerminal(
    "#000c18", "#c0bdbd", "#e5e5e5",
    "#000c18", "#cd3131", "#0dbc79", "#e5e510", "#2472c8",
    "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea",
    "#d670d6", "#29b8db", "#e5e5e5"
  ),
  ui: {
    base: "#000c18", mantle: "#031120", crust: "#041726",
    surface0: "#062037", surface1: "#0a2a44", surface2: "#0e3552",
    text: "#c0bdbd", subtext1: "#d0cdcd", subtext0: "#8a8a8a", overlay0: "#666666",
    accent: "#2472c8", accentFg: "#e5e5e5",
    green: "#0dbc79", red: "#cd3131", yellow: "#e5e510", teal: "#11a8cd",
  },
};

/** All built-in themes, in display order. */
export const THEMES: readonly HiveTheme[] = [
  catppuccinMocha,
  catppuccinLatte,
  nord,
  dracula,
  monokai,
  oneDark,
  gruvboxDark,
  solarizedLight,
  githubDark,
  githubLight,
  abyss,
];

const themeById = new Map<string, HiveTheme>(THEMES.map((t) => [t.id, t]));

/** Resolve a theme id to a theme, falling back to Catppuccin Mocha. */
export function getTheme(id: string | undefined | null): HiveTheme {
  return themeById.get(id ?? "") ?? catppuccinMocha;
}

export const DEFAULT_THEME_ID = catppuccinMocha.id;
