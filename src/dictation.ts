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
let badge: HTMLDivElement;

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

function onStatus(status: DictationStatus, detail: string | null): void {
  switch (status) {
    case "listening":
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
      show(`Dictation error: ${detail ?? ""}`, "error");
      break;
    case "idle":
    default:
      hide();
      break;
  }
}

export function initDictation(getActiveSessionId: () => number | undefined): void {
  badge = document.createElement("div");
  badge.className = "dictation-badge";
  badge.setAttribute("role", "status");
  document.body.appendChild(badge);

  const isDictationKey = (e: KeyboardEvent): boolean =>
    e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey && e.key.toLowerCase() === "d";

  const stop = (): void => {
    if (!active) return;
    active = false;
    invoke("dictation_stop").catch((err) => console.error("dictation_stop failed", err));
  };

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.repeat) return;
      if (!isDictationKey(e)) return;
      e.preventDefault();
      if (active) return;
      active = true;
      const engine = getSettings().dictationEngine;
      invoke("dictation_start", { engine }).catch((err) => {
        console.error("dictation_start failed", err);
        active = false;
      });
    },
    true
  );

  window.addEventListener(
    "keyup",
    (e) => {
      if (!isDictationKey(e)) return;
      stop();
    },
    true
  );

  window.addEventListener("blur", stop);

  listen<{ status: DictationStatus; detail?: string | null }>("dictation://status", (event) => {
    onStatus(event.payload.status, event.payload.detail ?? null);
  }).catch((err) => console.error("failed to listen for dictation status", err));

  listen<{ text: string }>("dictation://result", (event) => {
    const text = event.payload.text;
    if (!text) return;
    const sessionId = getActiveSessionId();
    if (sessionId === undefined) return;
    invoke("pty_write", { sessionId, data: text }).catch((err) =>
      console.error("failed to write dictation result", err)
    );
  }).catch((err) => console.error("failed to listen for dictation results", err));
}
