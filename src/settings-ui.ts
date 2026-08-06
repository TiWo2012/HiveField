/**
 * Settings page — a modal overlay with two tabs:
 *
 *  - **General**: font / Unicode / rendering / agents / worktrees / dictation /
 *    notifications options. Every control writes straight into the settings
 *    store, so changes apply live to all open terminals.
 *  - **Keybinds**: every configurable keyboard shortcut, click-to-record.
 *
 * A preview line shows the current font.
 */

import { invoke } from "@tauri-apps/api/core";
import { AGENTS } from "./agents";
import { THEMES } from "./themes";
import {
  getSettings,
  resetSettings,
  subscribe,
  updateSettings,
} from "./settings";
import {
  DEFAULT_KEYBINDS,
  KEYBIND_ACTIONS,
  formatKeybind,
  keyNeedsModifier,
  keybindEqual,
  parseKeybind,
  type KeybindAction,
} from "./keybinds";

const PREVIEW_TEXT = "AaBb 日本語 中文 🎉 → ①②③ NFO nf ";

let overlay: HTMLElement | null = null;
let previewEl: HTMLElement | null = null;
let unsubscribe: (() => void) | null = null;
/** Refresh the Keybinds tab rows whenever settings change (see openSettings). */
let renderKeybindRows: (() => void) | null = null;

export function openSettings(): void {
  if (!overlay) {
    overlay = buildOverlay();
    unsubscribe = subscribe((s) => {
      if (previewEl) {
        previewEl.style.fontFamily = `"${s.fontFamily}", monospace`;
        previewEl.style.fontSize = `${s.fontSize}px`;
      }
      renderKeybindRows?.();
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

function passwordField(value: string, onChange?: (v: string) => void): HTMLElement {
  const input = el("input", "settings-text");
  input.type = "password";
  input.autocomplete = "new-password";
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

/**
 * A checkbox per registered agent, controlling which ones are offered as
 * new-session sources. Unchecking an agent hides it from the sidebar, the
 * context menu and the palette (existing sessions keep running).
 */
function agentChecklist(): HTMLElement {
  const wrap = el("div", "settings-agents");
  const visible = new Set(getSettings().visibleAgents);
  for (const agent of AGENTS) {
    const item = el("label", "settings-agent");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "settings-toggle";
    cb.checked = visible.has(agent.id);
    cb.addEventListener("change", () => {
      const next = new Set(getSettings().visibleAgents);
      if (cb.checked) next.add(agent.id);
      else next.delete(agent.id);
      // Keep registry order so the sidebar/menu order stays stable.
      void updateSettings({
        visibleAgents: AGENTS.filter((a) => next.has(a.id)).map((a) => a.id),
      });
    });
    const name = el("span", "settings-agent-name");
    name.textContent = `${agent.icon} ${agent.label}`;
    item.append(cb, name);
    wrap.appendChild(item);
  }
  return wrap;
}

function section(title: string): HTMLElement {
  const sectionEl = el("div", "settings-section");
  const heading = el("h2", "settings-section-title");
  heading.textContent = title;
  sectionEl.appendChild(heading);
  return sectionEl;
}

/**
 * Prompt snippet editor: one editable row per snippet (name + content),
 * with a remove button and an "Add snippet" button. Every change writes
 * straight into the settings store, so the "Insert prompt…" picker always
 * reflects the current list.
 */
function promptSnippetsEditor(): HTMLElement {
  const wrap = el("div", "settings-snippets");

  const renderList = () => {
    wrap.textContent = "";
    const snippets = getSettings().promptSnippets;
    snippets.forEach((snippet, i) => {
      const row = el("div", "settings-snippet");

      const head = el("div", "settings-snippet-head");
      const nameInput = el("input", "settings-snippet-name");
      nameInput.type = "text";
      nameInput.value = snippet.name;
      nameInput.placeholder = "Prompt name";
      nameInput.spellcheck = false;
      nameInput.addEventListener("change", () => {
        const next = [...getSettings().promptSnippets];
        next[i] = { ...next[i], name: nameInput.value };
        void updateSettings({ promptSnippets: next });
      });
      const removeBtn = el("button", "settings-snippet-remove");
      removeBtn.type = "button";
      removeBtn.textContent = "✕";
      removeBtn.title = "Remove snippet";
      removeBtn.addEventListener("click", () => {
        const next = getSettings().promptSnippets.filter((_, j) => j !== i);
        void updateSettings({ promptSnippets: next });
      });
      head.append(nameInput, removeBtn);

      const contentInput = el("textarea", "settings-snippet-content");
      contentInput.value = snippet.content;
      contentInput.placeholder = "Prompt text inserted into the terminal";
      contentInput.spellcheck = false;
      contentInput.addEventListener("change", () => {
        const next = [...getSettings().promptSnippets];
        next[i] = { ...next[i], content: contentInput.value };
        void updateSettings({ promptSnippets: next });
      });

      row.append(head, contentInput);
      wrap.appendChild(row);
    });

    const addBtn = el("button", "settings-snippet-add");
    addBtn.type = "button";
    addBtn.textContent = "+ Add snippet";
    addBtn.addEventListener("click", () => {
      const next = [
        ...getSettings().promptSnippets,
        { name: "New prompt", content: "" },
      ];
      void updateSettings({ promptSnippets: next });
    });
    wrap.appendChild(addBtn);
  };

  renderList();
  return wrap;
}

/* ---- Snippets tab ---- */

function buildSnippetsTab(): HTMLElement {
  const panel = el("div", "settings-tab-panel");

  const hint = el("div", "settings-hint");
  const paletteKey = getSettings().keybinds.palette;
  hint.textContent =
    "Snippets paste into the active terminal via the command palette" +
    (paletteKey ? ` (${paletteKey} → Insert prompt…)` : " (→ Insert prompt…)") +
    ". Add, edit, or remove your own here.";
  panel.appendChild(hint);

  panel.appendChild(promptSnippetsEditor());
  return panel;
}

/* ---- General tab ---- */

function buildGeneralTab(): HTMLElement {
  const s = getSettings();
  const body = el("div", "settings-tab-panel");

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

  /* --- Theme --- */
  const themeSection = section("Theme");
  themeSection.appendChild(
    controlRow(
      "Color theme",
      selectField(
        s.theme,
        THEMES.map((t) => ({ value: t.id, label: t.name })),
        (theme) => updateSettings({ theme })
      ),
      "Applies to the terminal palette and the whole window chrome"
    )
  );
  themeSection.appendChild(
    controlRow(
      "Background opacity",
      numberField(s.backgroundOpacity, 0.25, 1, 0.05, (backgroundOpacity) =>
        updateSettings({ backgroundOpacity })
      ),
      "Below 1 the terminal background becomes translucent with a blur"
    )
  );
  body.appendChild(themeSection);

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

  /* --- Agents --- */
  const agentsSection = section("Agents");
  const agentsLabel = el("span", "settings-label");
  agentsLabel.textContent = "Show in sidebar";
  agentsSection.appendChild(agentsLabel);
  agentsSection.appendChild(agentChecklist());
  const agentsHint = el("span", "settings-hint");
  agentsHint.textContent =
    "Which coding agents are offered as new-session sources (sidebar, context menu, palette). The raw shell is always available.";
  agentsSection.appendChild(agentsHint);
  body.appendChild(agentsSection);

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
      "Hold the Dictate key (rebindable in the Keybinds tab) in the terminal to dictate; local engines download their model on first use"
    )
  );
  body.appendChild(dictationSection);

  /* --- Notifications --- */
  const notifySection = section("Notifications");
  notifySection.appendChild(
    controlRow(
      "Desktop notifications",
      toggleField(s.desktopNotifications, (desktopNotifications) =>
        updateSettings({ desktopNotifications })
      ),
      "Show a system notification when a background agent session finishes"
    )
  );
  notifySection.appendChild(
    controlRow(
      "Push notifications (ntfy)",
      toggleField(s.ntfyEnabled, (ntfyEnabled) => updateSettings({ ntfyEnabled })),
      "Publish agent-done notifications to an ntfy topic; subscribe your phone to receive them"
    )
  );
  notifySection.appendChild(
    controlRow(
      "Server",
      textField(s.ntfyServer, (ntfyServer) => updateSettings({ ntfyServer })),
      "ntfy base URL (default https://ntfy.sh, self-hosted instances welcome)"
    )
  );
  notifySection.appendChild(
    controlRow(
      "Topic",
      textField(s.ntfyTopic, (ntfyTopic) => updateSettings({ ntfyTopic })),
      "Published to <server>/<topic>; subscribe a device to receive the push"
    )
  );
  notifySection.appendChild(
    controlRow(
      "Access token",
      passwordField(s.ntfyToken, (ntfyToken) => updateSettings({ ntfyToken })),
      "Optional ntfy access token, sent as Authorization: Bearer (stored unencrypted in settings.json)"
    )
  );
  notifySection.appendChild(
    controlRow(
      "Test",
      (() => {
        const actions = el("div", "settings-actions");
        const test = (
          button: HTMLButtonElement,
          send: () => Promise<void>
        ) => {
          button.disabled = true;
          button.textContent = "Sending…";
          send()
            .then(() => {
              button.textContent = "Sent ✓";
            })
            .catch((err) => {
              button.textContent = "Failed";
              console.error("notification test failed", err);
            })
            .finally(() => {
              setTimeout(() => {
                button.disabled = false;
                button.textContent = button.dataset.label ?? "Test";
              }, 2500);
            });
        };
        const desktopBtn = el("button", "settings-done");
        desktopBtn.type = "button";
        desktopBtn.dataset.label = "Test desktop";
        desktopBtn.textContent = "Test desktop";
        desktopBtn.addEventListener("click", () =>
          test(desktopBtn, () =>
            invoke("notify_desktop", {
              title: "hiveField test",
              body: "Desktop notifications are working!",
            })
          )
        );
        const pushBtn = el("button", "settings-done");
        pushBtn.type = "button";
        pushBtn.dataset.label = "Test push";
        pushBtn.textContent = "Test push";
        pushBtn.addEventListener("click", () =>
          test(pushBtn, () =>
            invoke("ntfy_send", {
              title: "hiveField test",
              body: "Push notifications are working!",
            })
          )
        );
        actions.append(desktopBtn, pushBtn);
        return actions;
      })()
    )
  );
  body.appendChild(notifySection);

  /* --- Preview --- */
  const previewSection = section("Preview");
  previewEl = el("div", "settings-preview");
  previewEl.textContent = PREVIEW_TEXT;
  previewSection.appendChild(previewEl);
  body.appendChild(previewSection);

  return body;
}

/* ---- Keybinds tab ---- */

function buildKeybindsTab(): HTMLElement {
  const panel = el("div", "settings-tab-panel");

  const hint = el("div", "settings-hint");
  hint.textContent =
    "Click a binding and press the new keys. Backspace unbinds it, Esc cancels. Plain letters/digits/symbols need a modifier (Ctrl/Alt/Meta) so they don't swallow terminal typing.";
  panel.appendChild(hint);

  const list = el("div", "settings-keybinds");
  panel.appendChild(list);

  const message = el("div", "settings-keybind-message");
  panel.appendChild(message);

  const footer = el("div", "settings-keybind-footer");
  const resetBtn = el("button", "settings-reset");
  resetBtn.type = "button";
  resetBtn.textContent = "Reset keybinds to defaults";
  resetBtn.addEventListener("click", () => {
    void updateSettings({ keybinds: { ...DEFAULT_KEYBINDS } });
  });
  footer.appendChild(resetBtn);
  panel.appendChild(footer);

  let recording: KeybindAction | null = null;
  let recordingBtn: HTMLButtonElement | null = null;

  const showMessage = (text: string) => {
    message.textContent = text;
    message.classList.add("error");
  };
  const clearMessage = () => {
    message.textContent = "";
    message.classList.remove("error");
  };

  const stopRecording = (): void => {
    recording = null;
    recordingBtn = null;
    renderKeybindRows?.();
  };

  const render = (): void => {
    const kb = getSettings().keybinds;

    // Group every action by its current binding to flag duplicates.
    const byBinding = new Map<string, KeybindAction[]>();
    for (const def of KEYBIND_ACTIONS) {
      const binding = kb[def.id];
      if (!binding) continue;
      const bucket = byBinding.get(binding) ?? [];
      bucket.push(def.id);
      byBinding.set(binding, bucket);
    }
    const conflicting = new Set<KeybindAction>();
    for (const bucket of byBinding.values()) {
      if (bucket.length > 1) for (const id of bucket) conflicting.add(id);
    }

    list.replaceChildren();
    let lastGroup = "";
    for (const def of KEYBIND_ACTIONS) {
      if (def.group !== lastGroup) {
        lastGroup = def.group;
        const groupTitle = el("div", "settings-keybind-group");
        groupTitle.textContent = def.group;
        list.appendChild(groupTitle);
      }
      const row = el("div", "settings-row keybind-row");
      const label = el("span", "settings-label");
      label.textContent = def.label;
      row.appendChild(label);

      const btn = el("button", "settings-keybind-key");
      btn.type = "button";
      btn.dataset.action = def.id;
      const binding = kb[def.id];
      btn.textContent = binding || "unbound";
      if (!binding) btn.classList.add("unbound");
      if (conflicting.has(def.id)) btn.classList.add("conflict");
      if (recording === def.id) {
        btn.classList.add("recording");
        btn.textContent = "Press keys…";
        recordingBtn = btn;
      }
      btn.title = conflicting.has(def.id)
        ? "Bound to more than one action — the others won't fire"
        : binding
          ? `Click to rebind (currently ${binding})`
          : "Click to bind";
      btn.addEventListener("click", () => {
        recording = def.id;
        render();
      });
      row.appendChild(btn);
      list.appendChild(row);
    }
  };
  renderKeybindRows = render;

  // Capture recorded keys. Registered once (the overlay persists across
  // open/close); only acts while a row is recording. Capture phase +
  // stopImmediatePropagation so the combo never reaches the app's own global
  // shortcuts, xterm, or the modal's Esc-to-close handler.
  window.addEventListener(
    "keydown",
    (e) => {
      if (recording === null) return;
      // The modal may have been closed mid-recording (e.g. via × or the
      // backdrop); drop the stale recording state so it doesn't linger.
      if (!overlay?.isConnected) {
        recording = null;
        recordingBtn = null;
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        stopRecording();
        return;
      }
      if (e.key === "Backspace") {
        e.preventDefault();
        e.stopImmediatePropagation();
        const kb = getSettings().keybinds;
        void updateSettings({ keybinds: { ...kb, [recording]: "" } });
        stopRecording();
        return;
      }
      const formatted = formatKeybind(e);
      if (!formatted) return; // modifier-only keydown; keep waiting
      e.preventDefault();
      e.stopImmediatePropagation();

      const parsed = parseKeybind(formatted);
      if (!parsed) return;
      if (
        keyNeedsModifier(parsed.key) &&
        !parsed.ctrl &&
        !parsed.alt &&
        !parsed.meta
      ) {
        showMessage(
          `"${formatted}" needs a modifier (Ctrl/Alt/Meta) so it doesn't swallow terminal typing.`
        );
        return;
      }
      const kb = getSettings().keybinds;
      const clash = KEYBIND_ACTIONS.find(
        (a) => a.id !== recording && kb[a.id] && keybindEqual(kb[a.id], formatted)
      );
      if (clash) {
        showMessage(`"${formatted}" is already bound to "${clash.label}".`);
        return;
      }
      clearMessage();
      void updateSettings({ keybinds: { ...kb, [recording]: formatted } });
      stopRecording();
    },
    true
  );

  render();
  return panel;
}

/* ---- Build the modal ---- */

function buildOverlay(): HTMLElement {
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

  // Tab bar: General | Keybinds.
  const body = el("div", "settings-body");
  const tabbar = el("div", "settings-tabs");
  const tabButtons: HTMLButtonElement[] = [];
  const panels: Record<string, HTMLElement> = {};
  const activateTab = (id: string) => {
    for (const btn of tabButtons) {
      btn.classList.toggle("active", btn.dataset.tab === id);
    }
    for (const [panelId, panelEl] of Object.entries(panels)) {
      panelEl.classList.toggle("active", panelId === id);
    }
  };
  const addTab = (id: string, label: string, panel: HTMLElement) => {
    const btn = el("button", "settings-tab");
    btn.type = "button";
    btn.textContent = label;
    btn.dataset.tab = id;
    btn.addEventListener("click", () => activateTab(id));
    tabButtons.push(btn);
    tabbar.appendChild(btn);
    panels[id] = panel;
    body.appendChild(panel);
  };
  modal.appendChild(tabbar);
  addTab("general", "General", buildGeneralTab());
  addTab("snippets", "Snippets", buildSnippetsTab());
  addTab("keybinds", "Keybinds", buildKeybindsTab());
  activateTab("general");
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
