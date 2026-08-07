/**
 * Terminal bell: BEL (0x07) plays a synthesized bell tone and, when the
 * ringing session is not the one the user is looking at, raises a desktop
 * notification. Both halves are togglable from Settings → Terminal bell.
 */

import { invoke } from "@tauri-apps/api/core";
import { getSettings } from "./settings";
import {
  isPanelActive,
  isWindowFocused,
  panelStatus,
  parkedKeyFor,
  sessions,
  terminalSessions,
} from "./state";
import type { Terminal } from "@xterm/xterm";

/** Last time a bell notification was shown (bursts of BELs must not spam). */
let lastBellNotifyAt = 0;
const BELL_NOTIFY_THROTTLE_MS = 5000;

/** Shared WebAudio context for the synthesized bell tone (created lazily). */
let bellAudioCtx: AudioContext | null = null;

/**
 * Synthesize a classic terminal bell: a short decaying A5 sine with a softer
 * octave overtone. Uses Web Audio directly (xterm only *fires* `onBell`; the
 * sound is ours to make). Never throws — a blocked or absent audio device
 * just means silence, and the notification half still goes out.
 */
function playBellSound(): void {
  try {
    const win = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
    const Ctor = win.AudioContext ?? win.webkitAudioContext;
    if (!Ctor) return;
    bellAudioCtx ??= new Ctor();
    const ctx = bellAudioCtx;
    // WebKitGTK can start the context suspended until a user gesture; the
    // terminal is interactive, so a resume here usually succeeds.
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.35, now);
    out.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
    out.connect(ctx.destination);
    for (const [freq, amp] of [[880, 1], [1760, 0.35]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = amp;
      osc.connect(gain).connect(out);
      osc.start(now);
      osc.stop(now + 0.45);
    }
  } catch {
    // No audio available — the notification below still fires.
  }
}

/**
 * Handle a BEL from a terminal: play the bell tone and, unless the user is
 * actively watching the ringing pane, raise a desktop notification naming the
 * ringing session. Notifications are throttled so a burst of BELs (e.g.
 * `echo -e '\a\a\a'`) yields one notification, not a dozen; the sound plays
 * for every bell, like a real terminal.
 */
export function handleBell(terminal: Terminal): void {
  const settings = getSettings();
  if (settings.terminalBellSound) playBellSound();
  if (!settings.terminalBellNotify) return;

  // The user is looking right at the ringing pane: the sound is enough.
  const sessionId = terminalSessions.get(terminal);
  const entry = sessionId !== undefined ? sessions.get(sessionId) : undefined;
  const panelId = entry?.panel?.id;
  if (panelId !== undefined && isWindowFocused() && isPanelActive(panelId)) return;

  const now = Date.now();
  if (now - lastBellNotifyAt < BELL_NOTIFY_THROTTLE_MS) return;
  lastBellNotifyAt = now;

  // Prefer the live tab title; parked (hidden-workspace) sessions keep their
  // title in the re-keyed panel status.
  const title =
    entry?.panel?.title ??
    (sessionId !== undefined
      ? panelStatus.get(parkedKeyFor(sessionId))?.baseTitle
      : undefined);
  invoke("notify_desktop", {
    title: "Terminal bell",
    body: `“${title ?? "Terminal"}” rang`,
  }).catch((err) => console.error("notify_desktop failed", err));
}
