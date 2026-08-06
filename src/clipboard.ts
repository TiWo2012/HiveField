/**
 * Clipboard helpers for the context menu's Copy / Paste actions.
 *
 * The Tauri clipboard-manager plugin (permission-granted read/write text) is
 * the primary path; the async Clipboard API and a legacy
 * `document.execCommand` fallback cover webviews where the plugin is
 * unavailable. All paths are best-effort — callers should `.catch()` and
 * treat failure as "action unavailable".
 */

import {
  readText as pluginReadText,
  writeText as pluginWriteText,
} from "@tauri-apps/plugin-clipboard-manager";

/** Write `text` to the system clipboard. Rejects when every path fails. */
export async function copyText(text: string): Promise<void> {
  try {
    await pluginWriteText(text);
    return;
  } catch {
    // Fall through to the webview Clipboard API.
  }
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy path.
    }
  }
  await legacyCopy(text);
}

function legacyCopy(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    ta.remove();
    if (ok) resolve();
    else reject(new Error("clipboard write unavailable"));
  });
}

/** Read plain text from the system clipboard. Rejects when unavailable. */
export async function readClipboardText(): Promise<string> {
  try {
    return await pluginReadText();
  } catch {
    // Fall through to the webview Clipboard API.
  }
  if (navigator.clipboard?.readText) {
    try {
      return await navigator.clipboard.readText();
    } catch {
      // Fall through to the legacy path.
    }
  }
  return legacyPaste();
}

/**
 * Best-effort legacy paste: focus a hidden textarea and ask the webview to
 * paste into it. Most webviews block programmatic paste, in which case this
 * resolves with "" after a short timeout.
 */
function legacyPaste(): Promise<string> {
  return new Promise((resolve) => {
    const ta = document.createElement("textarea");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    const done = (text: string) => {
      ta.remove();
      resolve(text);
    };
    ta.addEventListener(
      "paste",
      (e) => done(e.clipboardData?.getData("text") ?? ""),
      { once: true }
    );
    setTimeout(() => done(""), 250);
    try {
      document.execCommand("paste");
    } catch {
      /* Blocked — the timeout resolves with "". */
    }
  });
}
