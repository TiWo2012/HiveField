/**
 * A small single-input modal, used for tab rename and workspace rename.
 * Resolves with the trimmed input on confirm (possibly empty), or `null`
 * when cancelled.
 */

export interface PromptModalOptions {
  title: string;
  label: string;
  placeholder?: string;
  hint?: string;
  value?: string;
  confirmText?: string;
}

export function openPromptModal(opts: PromptModalOptions): Promise<string | null> {
  document.querySelector(".settings-backdrop")?.remove();

  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "settings-backdrop";

    const modal = document.createElement("div");
    modal.className = "settings-modal prompt-modal";

    const header = document.createElement("div");
    header.className = "settings-header";
    const title = document.createElement("h1");
    title.className = "settings-title";
    title.textContent = opts.title;
    const closeBtn = document.createElement("button");
    closeBtn.className = "settings-close";
    closeBtn.type = "button";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(null);
    });
    header.append(title, closeBtn);
    modal.appendChild(header);

    const body = document.createElement("div");
    body.className = "settings-body";
    const label = document.createElement("label");
    label.className = "settings-label";
    label.textContent = opts.label;
    body.appendChild(label);
    const input = document.createElement("input");
    input.className = "settings-text";
    input.placeholder = opts.placeholder ?? "";
    input.autocomplete = "off";
    input.value = opts.value ?? "";
    body.appendChild(input);
    if (opts.hint) {
      const hint = document.createElement("div");
      hint.className = "settings-hint";
      hint.textContent = opts.hint;
      body.appendChild(hint);
    }
    modal.appendChild(body);

    const footer = document.createElement("div");
    footer.className = "settings-footer";
    const cancelBtn = document.createElement("button");
    cancelBtn.className = "settings-reset";
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(null);
    });
    const doneBtn = document.createElement("button");
    doneBtn.className = "settings-done";
    doneBtn.type = "button";
    doneBtn.textContent = opts.confirmText ?? "OK";
    doneBtn.addEventListener("click", () => {
      backdrop.remove();
      resolve(input.value.trim());
    });
    footer.append(cancelBtn, doneBtn);
    modal.appendChild(footer);

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();
    input.select();

    backdrop.addEventListener("mousedown", (e) => {
      if (e.target === backdrop) {
        backdrop.remove();
        resolve(null);
      }
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doneBtn.click();
      if (e.key === "Escape") {
        backdrop.remove();
        resolve(null);
      }
    });
  });
}
