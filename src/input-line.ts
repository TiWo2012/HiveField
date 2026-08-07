/**
 * Input-line title tracking and terminal-output parsing: turns the line a
 * user is typing into a pane title once it is submitted, and splits raw PTY
 * output into OSC 133 shell-integration markers + visible text (which drives
 * the tab activity/completion indicators).
 */

/** Maximum length of a pane title derived from a submitted input line. */
const MAX_PANE_TITLE_LEN = 60;

/**
 * Normalize a raw pane title: strip control characters, collapse whitespace,
 * trim, and truncate.
 */
export function sanitizeTitle(raw: string): string {
  let title = raw
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > MAX_PANE_TITLE_LEN) {
    title = `${title.slice(0, MAX_PANE_TITLE_LEN - 1)}…`;
  }
  return title;
}

/**
 * Turn a submitted input line into a tab title.
 */
export function inputLineToTitle(line: string): string {
  return sanitizeTitle(line);
}

/** Escape-sequence state needed to tell typed chars from CSI/SS3/OSC sequences. */
export interface InputLineState {
  line: string;
  /** 0 = normal, 1 = just saw ESC, 2 = inside a CSI/SS3/OSC sequence. */
  escape: 0 | 1 | 2;
}

/**
 * Update the pending input line from incoming keystrokes. `onSubmit` fires
 * with the buffered line when it is submitted (Enter), then the buffer resets.
 */
export function trackInputLine(
  state: InputLineState,
  data: string,
  onSubmit: (line: string) => void
): InputLineState {
  const chars = Array.from(data);
  let { line, escape } = state;

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const code = ch.codePointAt(0)!;

    if (escape === 1) {
      // Just saw ESC: only CSI/OSC/SS3/DCS/APC/PM introducers continue.
      escape = [0x5b, 0x5d, 0x50, 0x5e, 0x5f, 0x4f].includes(code) ? 2 : 0;
      continue;
    }
    if (escape === 2) {
      // Inside a sequence: a final byte (0x40-0x7e) or BEL ends it.
      if (code === 0x07 || (code >= 0x40 && code <= 0x7e)) escape = 0;
      else if (code === 0x1b) escape = 1; // possible ST (ESC \)
      continue;
    }

    if (ch === "\x1b") {
      escape = 1;
    } else if (ch === "\r" || ch === "\n") {
      onSubmit(line);
      line = "";
    } else if (ch === "\x7f" || ch === "\x08") {
      // Backspace: drop the last code point (surrogate-safe).
      line = Array.from(line).slice(0, -1).join("");
    } else if (ch === "\x15") {
      // Ctrl+U: clear the whole line.
      line = "";
    } else if (ch === "\x17") {
      // Ctrl+W: delete the last word.
      line = line.replace(/\s*\S+\s*$/, "");
    } else if (ch < " ") {
      // Other control characters: not part of the input line.
    } else {
      line += ch;
    }
  }

  return { line, escape };
}

/** OSC 133 shell-integration marker regex (ESC ] 133 ; A/B/C/D ; … BEL|ST). */
const OSC133_SRC = "\\x1b\\]133;([ABCD])(?:[^\\x07\\x1b]*)(?:\\x07|\\x1b\\\\)";
const OSC133_RE = new RegExp(OSC133_SRC, "g");

/**
 * Split a terminal output chunk into shell-integration markers (OSC 133) and
 * the remaining visible text. Only complete markers (with a BEL/ST terminator)
 * are stripped; a marker split across reads is left in the text so xterm can
 * buffer it like any other OSC instead of leaking its payload bytes.
 */
export function analyzeOutput(data: string): { markers: string[]; text: string } {
  const markers: string[] = [];
  let text = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = OSC133_RE.exec(data)) !== null) {
    text += data.slice(last, m.index);
    markers.push(m[1]);
    last = m.index + m[0].length;
  }
  text += data.slice(last);
  return { markers, text };
}
