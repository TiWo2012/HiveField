/**
 * Keybinding registry: every app action that can be bound to a keyboard
 * shortcut, its default binding, and the parse/format/match helpers that
 * translate between KeyboardEvents and stored "Ctrl+Shift+T" strings.
 *
 * The live bindings live in `AppSettings.keybinds` (see settings.ts); this
 * module only holds the action catalog and the defaults, so both the settings
 * store and the UI can import it without a circular dependency.
 */

export type KeybindAction =
  | "newTab"
  | "newWindow"
  | "closePanel"
  | "renameTab"
  | "paste"
  | "copy"
  | "find"
  | "palette"
  | "settings"
  | "focusLeft"
  | "focusDown"
  | "focusUp"
  | "focusRight"
  | "nextTab"
  | "previousTab"
  | "fullscreen"
  | "zoomIn"
  | "zoomOut"
  | "dictate"
  | "workspace1"
  | "workspace2"
  | "workspace3"
  | "workspace4"
  | "workspace5"
  | "workspace6"
  | "workspace7"
  | "workspace8"
  | "workspace9"
  | "workspace10"
  | "broadcastToggle";

export interface KeybindDef {
  id: KeybindAction;
  label: string;
  group: string;
  default: string;
}

/** Every configurable action, in display order. */
export const KEYBIND_ACTIONS: KeybindDef[] = [
  { id: "newTab", label: "New agent tab", group: "Sessions", default: "Ctrl+Shift+T" },
  { id: "newWindow", label: "New window", group: "Window", default: "Ctrl+Shift+N" },
  { id: "closePanel", label: "Close active panel", group: "Sessions", default: "Ctrl+Shift+W" },
  { id: "renameTab", label: "Rename active tab", group: "Sessions", default: "Ctrl+Shift+R" },
  { id: "paste", label: "Paste clipboard", group: "Clipboard", default: "Ctrl+Shift+V" },
  { id: "copy", label: "Copy selection", group: "Clipboard", default: "Ctrl+Shift+C" },
  { id: "find", label: "Find in terminal", group: "Navigation", default: "Ctrl+Shift+F" },
  { id: "palette", label: "Command palette", group: "Navigation", default: "Ctrl+Shift+P" },
  { id: "settings", label: "Open settings", group: "Navigation", default: "Ctrl+," },
  { id: "focusLeft", label: "Focus pane left", group: "Pane focus", default: "Ctrl+H" },
  { id: "focusDown", label: "Focus pane down", group: "Pane focus", default: "Ctrl+J" },
  { id: "focusUp", label: "Focus pane up", group: "Pane focus", default: "Ctrl+K" },
  { id: "focusRight", label: "Focus pane right", group: "Pane focus", default: "Ctrl+L" },
  { id: "nextTab", label: "Next tab", group: "Tabs", default: "Ctrl+Tab" },
  { id: "previousTab", label: "Previous tab", group: "Tabs", default: "Ctrl+Shift+Tab" },
  { id: "fullscreen", label: "Fullscreen active pane", group: "Tabs", default: "Ctrl+F" },
  { id: "zoomIn", label: "Increase font size", group: "Font", default: "Ctrl+=" },
  { id: "zoomOut", label: "Decrease font size", group: "Font", default: "Ctrl+-" },
  { id: "dictate", label: "Dictate (hold)", group: "Dictation", default: "Ctrl+Alt+D" },
  { id: "workspace1", label: "Switch to workspace 1", group: "Workspaces", default: "Ctrl+1" },
  { id: "workspace2", label: "Switch to workspace 2", group: "Workspaces", default: "Ctrl+2" },
  { id: "workspace3", label: "Switch to workspace 3", group: "Workspaces", default: "Ctrl+3" },
  { id: "workspace4", label: "Switch to workspace 4", group: "Workspaces", default: "Ctrl+4" },
  { id: "workspace5", label: "Switch to workspace 5", group: "Workspaces", default: "Ctrl+5" },
  { id: "workspace6", label: "Switch to workspace 6", group: "Workspaces", default: "Ctrl+6" },
  { id: "workspace7", label: "Switch to workspace 7", group: "Workspaces", default: "Ctrl+7" },
  { id: "workspace8", label: "Switch to workspace 8", group: "Workspaces", default: "Ctrl+8" },
  { id: "workspace9", label: "Switch to workspace 9", group: "Workspaces", default: "Ctrl+9" },
  { id: "workspace10", label: "Switch to workspace 10", group: "Workspaces", default: "Ctrl+0" },
  { id: "broadcastToggle", label: "Broadcast to all panes", group: "Sessions", default: "Ctrl+Shift+B" },
];

/** The defaults, keyed by action id. */
export const DEFAULT_KEYBINDS: Record<KeybindAction, string> = Object.fromEntries(
  KEYBIND_ACTIONS.map((a) => [a.id, a.default])
) as Record<KeybindAction, string>;

export interface ParsedKeybind {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  key: string;
}

/** Modifier-only keys never carry a binding of their own. */
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

/**
 * Canonical name for a key: letters are uppercased (so "Ctrl+t" and
 * "Ctrl+Shift+T" compare equal), Space is spelled out, symbols and named keys
 * (Enter, ArrowUp, F5, …) are kept as-is.
 */
export function normalizeKeyName(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return key;
}

/**
 * Render a KeyboardEvent as a stored binding string ("Ctrl+Shift+T"). Returns
 * null for modifier-only keys and IME/dead keys, which can't be bound.
 */
export function formatKeybind(e: KeyboardEvent): string | null {
  if (
    e.key === "Dead" ||
    e.key === "Process" ||
    e.key === "Unidentified" ||
    MODIFIER_KEYS.has(e.key)
  ) {
    return null;
  }
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.metaKey) parts.push("Meta");
  parts.push(normalizeKeyName(e.key));
  return parts.join("+");
}

// Match leading modifiers in any order the UI ever produces (modifiers are
// always written Ctrl+Alt+Shift+Meta+key). The key itself may contain "+" —
// e.g. recording Ctrl+Shift+= on a US layout yields e.key "+".
const MOD_PATTERN =
  /^(?:(Ctrl|Control)\+)?(?:(Alt)\+)?(?:(Shift)\+)?(?:(Meta|Cmd|Win|Super)\+)?(.+)$/i;

/** Parse a stored binding string into modifier flags + key. Null when invalid. */
export function parseKeybind(str: string): ParsedKeybind | null {
  const match = MOD_PATTERN.exec(str.trim());
  if (!match) return null;
  const [, ctrl, alt, shift, meta, key] = match;
  if (!key) return null;
  return {
    ctrl: Boolean(ctrl),
    alt: Boolean(alt),
    shift: Boolean(shift),
    meta: Boolean(meta),
    key: normalizeKeyName(key),
  };
}

/** Does a keydown/keyup event match the given stored binding ("" = unbound)? */
export function matchesKeybind(
  binding: string | undefined,
  e: KeyboardEvent
): boolean {
  if (!binding) return false;
  const parsed = parseKeybind(binding);
  if (!parsed) return false;
  if (e.ctrlKey !== parsed.ctrl) return false;
  if (e.altKey !== parsed.alt) return false;
  if (e.shiftKey !== parsed.shift) return false;
  if (e.metaKey !== parsed.meta) return false;
  return normalizeKeyName(e.key) === parsed.key;
}

/**
 * Canonical equality for two stored binding strings (case-insensitive on the
 * key, so "Ctrl+Shift+T" and "Ctrl+Shift+t" are the same binding).
 */
export function keybindEqual(a: string, b: string): boolean {
  const pa = parseKeybind(a);
  const pb = parseKeybind(b);
  if (!pa || !pb) return false;
  return (
    pa.ctrl === pb.ctrl &&
    pa.alt === pb.alt &&
    pa.shift === pb.shift &&
    pa.meta === pb.meta &&
    pa.key === pb.key
  );
}

/**
 * A bare binding on a printable character (letter, digit, symbol) would be
 * swallowed by the app instead of reaching the terminal, so it must carry at
 * least one modifier. Named keys (F-keys, arrows, Enter, Space, …) are fine
 * bare.
 */
export function keyNeedsModifier(key: string): boolean {
  return key.length === 1 && !MODIFIER_KEYS.has(key);
}

/**
 * Does a keybind entry match a search query? Case-insensitive substring match
 * over the action's label, its group, and its current binding string. The
 * query is split on whitespace and every token must match at least one field,
 * so "new tab" finds "New agent tab" and "ctrl t" finds "Ctrl+Shift+T". An
 * empty query matches everything.
 */
export function keybindSearchMatches(
  def: KeybindDef,
  binding: string,
  query: string
): boolean {
  const fields = [def.group, def.label, binding].map((s) => s.toLowerCase());
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  return tokens.every((token) =>
    fields.some((field) => field.includes(token))
  );
}
