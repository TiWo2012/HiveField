/**
 * Settings page — a modal overlay for font / Unicode / rendering options.
 *
 * Every control writes straight into the settings store, so changes apply
 * live to all open terminals. A preview line shows the current font.
 */

import {
  NERD_FONT_PRESETS,
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

function textField(value: string, listId: string | undefined, onChange?: (v: string) => void): HTMLElement {
  const input = el("input", "settings-text");
  input.type = "text";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.value = value;
  if (listId) input.setAttribute("list", listId);
  input.addEventListener("input", () => onChange?.(input.value));
  return input;
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
  const fontList = el("datalist", "settings-font-presets");
  fontList.id = "settings-font-presets";
  for (const name of NERD_FONT_PRESETS) {
    const optionEl = el("option");
    optionEl.value = name;
    fontList.appendChild(optionEl);
  }
  modal.appendChild(fontList); // datalist must be attached to the document

  fontSection.appendChild(
    controlRow(
      "Font family",
      textField(s.fontFamily, fontList.id, (fontFamily) => updateSettings({ fontFamily })),
      "A Nerd Font installed on your system enables icon glyphs"
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
