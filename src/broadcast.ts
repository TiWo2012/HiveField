/**
 * Broadcast input to all visible panes (Ctrl+Shift+B toggle).
 *
 * When enabled, every keystroke and paste in the active terminal is also
 * forwarded to every other visible pane in the current workspace.
 * Background (parked) sessions are never included so accidental destructive
 * input never reaches a hidden workspace.
 */

import { invoke } from "@tauri-apps/api/core";
import { getApi, panelToSession, parkedSessions } from "./state";

let broadcasting = false;

/** Listeners notified when the broadcast state changes (status bar, etc.). */
const listeners = new Set<(on: boolean) => void>();

export function isBroadcasting(): boolean {
  return broadcasting;
}

/** Toggle broadcast on/off; returns the new state. */
export function toggleBroadcast(): boolean {
  broadcasting = !broadcasting;
  for (const l of listeners) l(broadcasting);
  return broadcasting;
}

/** Subscribe to broadcast state changes. Returns an unsubscribe function. */
export function onBroadcastChange(listener: (on: boolean) => void): () => void {
  listeners.add(listener);
  listener(broadcasting);
  return () => listeners.delete(listener);
}

/**
 * Write `data` to every visible session *except* the sender.
 *
 * @param senderSessionId  The session that originated the input (skipped).
 * @param data             Raw terminal data to forward.
 */
export function broadcastToAll(senderSessionId: number, data: string): void {
  if (!broadcasting) return;
  const api = getApi();
  for (const panel of api.panels) {
    const sid = panelToSession.get(panel.id);
    if (sid === undefined || sid === senderSessionId) continue;
    // Never broadcast to a parked (background-workspace) session — only
    // the visible panes in the current workspace receive forwarded input.
    if (parkedSessions.has(sid)) continue;
    invoke("pty_write", { sessionId: sid, data }).catch(() => {});
  }
}
