/**
 * Settings page — a modal overlay for font / Unicode / rendering options.
 *
 * Every control writes straight into the settings store, so changes apply
 * live to all open terminals. A preview line shows the current font.
 */

import { invoke } from "@tauri-apps/api/core";
import {
  getSettings,
  resetSettings,
  subscribe,
  updateSettings,
  type AppSettings,
} from "./settings";

const PREVIEW_TEXT = "AaBb 日本語 中文 🎉 → ①②③ NFO nf ";

let overlay: HTMLElement | null = null;
let previewEl: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;

export function openSettings(): void {
  if (!overlay) {
    overlay = buildOverlay();
    unsubscribe = subscribe((s) => {
      if (previewEl) {
        previewEl.style.fontFamily = `"${s.fontFamily}", monospace`;
        previewEl.style.fontSize = `${s.fontSize}px`;
      }
    });
    document.addEventListener("keydown", onKeydown);
  }
  if (!overlay.isConnected) document.body.appendChild(overlay);
}

export function closeSettings(): void {
  overlay?.remove();
}

export function toggleSettings(): void {
  if (overlay && overlay.isConnected) closeSettings();
  else openSettings();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape" && overlay?.isConnected) {
    e.preventDefault();
    e.stopPropagation();
    closeSettings();
  }
}

/* ---- DOM helpers ---- */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function controlRow(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const rowEl = el("label", "settings-row");
  const labelEl = el("span", "settings-label");
  labelEl.textContent = label;
  rowEl.appendChild(labelEl);
  const right = el("span", "settings-control");
  right.appendChild(control);
  rowEl.appendChild(right);
  if (hint) {
    const hintEl = el("span", "settings-hint");
    hintEl.textContent = hint;
    rowEl.appendChild(hintEl);
  }
  return rowEl;
}

function fontSelect(current: string, onChange?: (v: string) => void): HTMLElement {
  const select = el("select", "settings-select");
  const addOption = (value: string) => {
    const optionEl = el("option");
    optionEl.value = value;
    optionEl.textContent = value;
    select.appendChild(optionEl);
  };

  addOption(current);
  select.value = current;
  select.addEventListener("change", () => onChange?.(select.value));

  invoke<string[]>("list_system_fonts")
    .then((fonts) => {
      // Replace the placeholder option with the full system list, keeping the
      // current font visible (and without duplicates) when it isn't installed.
      select.replaceChildren();
      if (!fonts.includes(current)) addOption(current);
      for (const font of fonts) addOption(font);
      select.value = current;
    })
    .catch((err) => {
      console.error("Failed to load system fonts:", err);
    });

  return select;
}

function numberField(value: number, min: number, max: number, step: number, onChange?: (v: number) => void): HTMLElement {
  const input = el("input", "settings-number");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onChange?.(v);
  });
  return input;
}

function textField(value: string, onChange?: (v: string) => void): HTMLElement {
  const input = el("input", "settings-text");
  input.type = "text";
  input.value = value;
  input.addEventListener("change", () => onChange?.(input.value));
  return input;
}

function selectField<T extends string>(
  value: T,
  options: ReadonlyArray<{ value: T; label: string }>,
  onChange?: (v: T) => void
): HTMLElement {
  const select = el("select", "settings-select");
  for (const opt of options) {
    const optionEl = el("option");
    optionEl.value = opt.value;
    optionEl.textContent = opt.label;
    select.appendChild(optionEl);
  }
  select.value = value;
  select.addEventListener("change", () => onChange?.(select.value as T));
  return select;
}

function toggleField(value: boolean, onChange?: (v: boolean) => void): HTMLElement {
  const input = el("input", "settings-toggle");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => onChange?.(input.checked));
  return input;
}

function section(title: string): HTMLElement {
  const sectionEl = el("div", "settings-section");
  const heading = el("h2", "settings-section-title");
  heading.textContent = title;
  sectionEl.appendChild(heading);
  return sectionEl;
}

/* ---- Build the modal ---- */

function buildOverlay(): HTMLElement {
  const s = getSettings();

  const backdrop = el("div", "settings-backdrop");
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) closeSettings();
  });

  const modal = el("div", "settings-modal");

  const header = el("div", "settings-header");
  const title = el("h1", "settings-title");
  title.textContent = "Settings";
  const closeBtn = el("button", "settings-close");
  closeBtn.type = "button";
  closeBtn.textContent = "×";
  closeBtn.title = "Close (Esc)";
  closeBtn.addEventListener("click", closeSettings);
  header.append(title, closeBtn);
  modal.appendChild(header);

  const body = el("div", "settings-body");

  /* --- Font --- */
  const fontSection = section("Font");
  fontSection.appendChild(
    controlRow(
      "Font family",
      fontSelect(s.fontFamily, (fontFamily) => updateSettings({ fontFamily })),
      "Any font installed on your system"
    )
  );
  fontSection.appendChild(
    controlRow(
      "Font size",
      numberField(s.fontSize, 6, 48, 1, (fontSize) => updateSettings({ fontSize })),
      "px"
    )
  );
  fontSection.appendChild(
    controlRow(
      "Line height",
      numberField(s.lineHeight, 0.5, 3, 0.1, (lineHeight) => updateSettings({ lineHeight })),
      "× cell height"
    )
  );
  fontSection.appendChild(
    controlRow(
      "Letter spacing",
      numberField(s.letterSpacing, -2, 8, 0.5, (letterSpacing) => updateSettings({ letterSpacing })),
      "px"
    )
  );
  fontSection.appendChild(
    controlRow(
      "Font weight",
      selectField(
        s.fontWeight,
        [
          { value: "normal", label: "Normal" },
          { value: "bold", label: "Bold" },
        ],
        (fontWeight) => updateSettings({ fontWeight })
      )
    )
  );
  fontSection.appendChild(
    controlRow(
      "Bold weight",
      selectField(
        s.fontWeightBold,
        [
          { value: "normal", label: "Normal" },
          { value: "bold", label: "Bold" },
        ],
        (fontWeightBold) => updateSettings({ fontWeightBold })
      )
    )
  );
  fontSection.appendChild(
    controlRow(
      "Font ligatures",
      toggleField(s.fontLigatures, (fontLigatures) => updateSettings({ fontLigatures })),
      "Render programming ligatures (e.g. ->, =>, ==) when the font supports them"
    )
  );
  body.appendChild(fontSection);

  /* --- Unicode --- */
  const unicodeSection = section("Unicode");
  unicodeSection.appendChild(
    controlRow(
      "Unicode version",
      selectField(
        s.unicodeVersion,
        [
          { value: "6", label: "Unicode 6 (compat)" },
          { value: "11", label: "Unicode 11 (full)" },
        ],
        (unicodeVersion) => updateSettings({ unicodeVersion })
      ),
      "Unicode 11 renders modern emoji and CJK at the correct width"
    )
  );
  body.appendChild(unicodeSection);

  /* --- Rendering --- */
  const renderSection = section("Rendering");
  renderSection.appendChild(
    controlRow(
      "Cursor blink",
      toggleField(s.cursorBlink, (cursorBlink) => updateSettings({ cursorBlink }))
    )
  );
  renderSection.appendChild(
    controlRow(
      "Minimum contrast ratio",
      numberField(s.minimumContrastRatio, 1, 21, 0.5, (minimumContrastRatio) =>
        updateSettings({ minimumContrastRatio })
      ),
      "Boost foreground text contrast against the background (1 = off)"
    )
  );
  body.appendChild(renderSection);

  /* --- Worktrees --- */
  const worktreeSection = section("Worktrees");
  worktreeSection.appendChild(
    controlRow(
      "Worktree base dir",
      textField(s.worktreeBaseDir, (worktreeBaseDir) => updateSettings({ worktreeBaseDir })),
      "Where \"worktree session\" checkouts are created (e.g. /tmp)"
    )
  );
  body.appendChild(worktreeSection);

  /* --- Dictation --- */
  const dictationSection = section("Dictation");
  dictationSection.appendChild(
    controlRow(
      "Engine",
      selectField(
        s.dictationEngine,
        [
          { value: "whisper", label: "Whisper (local)" },
          { value: "vosk", label: "Vosk (local)" },
          { value: "cloud", label: "Cloud API" },
        ],
        (dictationEngine) => updateSettings({ dictationEngine })
      ),
      "Hold Ctrl+Alt+D in the terminal to dictate; local engines download their model on first use"
    )
  );
  body.appendChild(dictationSection);

  /* --- Preview --- */
  const previewSection = section("Preview");
  previewEl = el("div", "settings-preview");
  previewEl.textContent = PREVIEW_TEXT;
  previewSection.appendChild(previewEl);
  body.appendChild(previewSection);

  modal.appendChild(body);

  const footer = el("div", "settings-footer");
  const resetBtn = el("button", "settings-reset");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => resetSettings());
  const doneBtn = el("button", "settings-done");
  doneBtn.type = "button";
  doneBtn.textContent = "Close";
  doneBtn.addEventListener("click", closeSettings);
  footer.append(resetBtn, doneBtn);
  modal.appendChild(footer);

  backdrop.appendChild(modal);
  return backdrop;
}
