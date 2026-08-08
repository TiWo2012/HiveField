import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getSettings } from "./settings";

type DictationStatus =
  | "idle"
  | "listening"
  | "transcribing"
  | "model_loading"
  | "downloading"
  | "error";

let active = false;
/**
 * True once capture actually started (status "listening"). Stays false while a
 * model download/load is still in flight so the keyup path does not try to
 * stop a capture that never began, and so the "idle" status (download/load
 * finished) can trigger a retry that starts capture while the key is held.
 */
let started = false;
let badge: HTMLDivElement;

/**
 * The session the dictation result must be written into, captured at keydown
 * (not at result time): cloud transcription takes seconds, and switching panes
 * in between must not redirect the text into a different terminal. Sent to the
 * backend with `dictation_start` and echoed back in the result payload.
 */
let targetSessionId: number | undefined;

/** Timer that hides a sticky error badge after a while. */
let errorTimer: ReturnType<typeof setTimeout> | undefined;

/** How long a "Dictation error" badge stays visible before hiding itself. */
const ERROR_BADGE_MS = 8000;

function show(text: string, className?: string): void {
  badge.textContent = text;
  badge.classList.remove("listening", "error");
  if (className) badge.classList.add(className);
  badge.classList.add("visible");
}

function hide(): void {
  badge.classList.remove("listening", "error");
  badge.classList.remove("visible");
}

/**
 * Start dictation capture, called from keyboard.ts when the dictate keybind
 * is pressed. The caller must supply the current active session id so the
 * result lands in the right terminal even if focus changes before the
 * transcription completes.
 */
export function startDictation(sessionId: number | undefined): void {
  if (active) return;
  active = true;
  started = false;
  targetSessionId = sessionId;
  void beginCapture();
}

/** Stop an ongoing dictation capture (released keybind or window blur). */
export function stopDictation(): void {
  if (!active) return;
  active = false;
  started = false;
  invoke("dictation_stop").catch((err) => console.error("dictation_stop failed", err));
}

/**
 * Ask the backend to start dictation. A download/load may still be in flight
 * when this resolves — the "idle" status handler retries while the key is
 * still held, so hold-to-dictate survives first use.
 */
async function beginCapture(): Promise<void> {
  try {
    await invoke("dictation_start", {
      engine: getSettings().dictationEngine,
      device: getSettings().dictationMic,
      sessionId: targetSessionId,
    });
  } catch (err) {
    // A rejected start (missing API key, another window already dictating,
    // no microphone): the hold is over, don't keep retrying.
    console.error("dictation_start failed", err);
    active = false;
    started = false;
  }
}

function onStatus(status: DictationStatus, detail: string | null): void {
  clearTimeout(errorTimer);
  // While a capture is live, background work triggered elsewhere (e.g. a model
  // download started by another window) must not clobber this window's badge:
  // the capture's own listening → transcribing → idle flow owns it.
  if (started && (status === "idle" || status === "downloading" || status === "model_loading")) {
    return;
  }
  switch (status) {
    case "listening":
      started = true;
      show("🎤 Listening…", "listening");
      break;
    case "transcribing":
      show("Transcribing…");
      break;
    case "model_loading":
      show("Loading Whisper model…");
      break;
    case "downloading":
      show(`Downloading Whisper model…${detail ? ` ${detail}` : ""}`);
      break;
    case "error":
      // An error ends the hold (the backend rejected the start, or a download/
      // transcription failed): reset the active flag so the keyup is a no-op
      // and the badge is not stuck until the next successful start.
      started = false;
      active = false;
      show(`Dictation error: ${detail ?? ""}`, "error");
      errorTimer = setTimeout(hide, ERROR_BADGE_MS);
      break;
    case "idle":
    default:
      if (active && !started) {
        // A download or model load just finished while the key is still held:
        // start capture now (hold-to-talk survives first use / first load).
        void beginCapture();
      } else {
        hide();
      }
      break;
  }
}

export function initDictation(): void {
  badge = document.createElement("div");
  badge.className = "dictation-badge";
  badge.setAttribute("role", "status");
  document.body.appendChild(badge);

  listen<{ status: DictationStatus; detail?: string | null }>("dictation://status", (event) => {
    onStatus(event.payload.status, event.payload.detail ?? null);
  }).catch((err) => console.error("failed to listen for dictation status", err));

  listen<{ text: string; sessionId?: number | null }>("dictation://result", (event) => {
    const text = event.payload.text;
    if (!text) return;
    // The backend echoes the session id captured at keydown, so the text goes
    // to the terminal that was active when dictation *started*. Fall back to
    // the target captured by startDictation() for payloads without a sessionId.
    const sessionId = event.payload.sessionId ?? targetSessionId;
    if (sessionId === undefined) return;
    // Trailing space so text typed right after dictation doesn't run into the
    // transcription ("world" + typed text -> "worldls").
    invoke("pty_write", { sessionId, data: `${text} ` }).catch((err) =>
      console.error("failed to write dictation result", err)
    );
  }).catch((err) => console.error("failed to listen for dictation results", err));
}
