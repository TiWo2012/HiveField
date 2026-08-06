/**
 * Prompt snippets: named chunks of text inserted into the active terminal.
 *
 * The snippet list lives in the settings store (`promptSnippets`, see
 * settings.ts) so users can edit it in Settings → Prompt snippets. The
 * command palette offers a two-step flow: Ctrl+Shift+P → "Insert prompt…"
 * opens a scoped picker listing every snippet; activating one pastes its
 * content into the active terminal (bracketed-paste aware, like Ctrl+Shift+V).
 */

import { getSettings, type PromptSnippet } from "./settings";
import type { PaletteItem } from "./palette";

/** Fallback label shown for snippets whose name was left blank. */
const UNNAMED = "(unnamed)";

/** First line of a snippet's content, truncated, for the picker's detail column. */
function previewLine(content: string): string {
  const first = content.split("\n")[0] ?? "";
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}

/**
 * Build the picker items for the "Insert prompt…" sub-picker: one row per
 * configured snippet, newest editing order preserved. `insert` is called with
 * the chosen snippet; the caller decides what inserting means (main.ts pastes
 * it into the active terminal).
 */
export function snippetPickerItems(insert: (snippet: PromptSnippet) => void): PaletteItem[] {
  return getSettings().promptSnippets.map((snippet, i) => ({
    id: `snippet-${i}`,
    label: snippet.name.trim() || UNNAMED,
    detail: previewLine(snippet.content),
    icon: "✎",
    group: "Prompts",
    run: () => insert(snippet),
  }));
}
