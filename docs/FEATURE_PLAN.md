# Feature Plan — hiveField Terminal

A shortlist of five new features, scoped to the existing architecture
(Tauri v2 backend + xterm.js/dockview frontend, single `src/main.ts` app
module with small satellite modules). Each feature is independently
implementable, lands as its own branch merged back to `master`, and follows
the existing patterns: IPC command in `src-tauri/src/lib.rs`, keybinding in
`src/keybinds.ts`, palette/context-menu wiring in `src/main.ts`, settings in
`src/settings.ts` + `src/settings-ui.ts`.

Ordered by size: **5 → 2 → 3 → 1 → 4**. (1 and 4 are the biggest; 5 is a
couple of hours.)

---

## 1. Broadcast input to all sessions (send-to-all)

**Problem.** When a user runs the same command across several agents or raw
panes (e.g. "pull latest", "run the tests", `git stash`), they currently have
to type it into each pane by hand. A terminal multiplexer should offer an
iTerm2-style "send input to all sessions" toggle.

**Design.**

- New module-level state in `src/main.ts`: `broadcastEnabled: boolean`.
- Toggle via a new keybind (`Ctrl+Shift+B`), a **Command palette** action
  ("Toggle broadcast input to all panes"), and a status-bar button (see
  below). Toggle state is per window (module scope), not persisted.
- While enabled, a capture-phase `window` keydown listener (registered next to
  the existing global-shortcut handler around `main.ts:3028`) intercepts keys
  **before xterm's own handlers** and, instead of letting only the active
  terminal translate them:
  1. Translates the `KeyboardEvent` into the byte sequence xterm would have
     produced (`keydownToBytes(e)`), reusing the same mapping rules xterm
     applies internally:
     - printable char → its code point
     - `Ctrl+letter` → control byte (`0x01`–`0x1A`)
     - `Enter` → `\r`, `Tab` → `\t`, `Backspace` → `\x7f`, `Esc` → `\x1b`
     - `Alt+key` → `\x1b` + key
     - arrows / function keys → CSI sequences (`\x1b[A` … )
     - `Ctrl+Shift+V` → bracketed-paste to **all** sessions (reuse the
       existing paste path in `clipboard.ts`)
  2. `preventDefault()` so xterm never double-writes to the active terminal.
  3. `pty_write`s the bytes to **every live session in the current workspace**
     (all panes in the dockview layout), including the active one.
- Bail out (let the active terminal handle the key natively) when the event
  target is an `<input>`/`<textarea>`, the palette/search/settings/rename
  overlays are open, a drag is in flight, or the key can't be translated
  (dead keys, IME composition). Broadcast is best-effort for exotic keys.
- **Scope decision:** send to the current workspace's visible panes only —
  *not* to background/parked sessions in other workspace slots (sending
  keystrokes into a workspace the user isn't looking at is surprising and
  potentially destructive). Document this in the README.
- **Status bar.** Add a slim strip at the bottom of `#terminal` (a sibling of
  the dockview element, below it — no dockview API involvement). It shows:
  - a **broadcast toggle button** (`⤳ All panes`), highlighted while active
  - the active session's mode label + cwd (cheap, reuses existing state)
  This gives the broadcast state a permanent, visible home and a click target.

**Changes.**
- `src/main.ts` — broadcast state, `keydownToBytes()`, capture-phase
  interceptor, status-bar element, palette action, context-menu entry
  (optional), `pty_write` fan-out.
- `src/keybinds.ts` — new `broadcast` action (group "Sessions", default
  `Ctrl+Shift+B`).
- `src/palette.ts` — no change (items come from `main.ts` via the context).
- `src/styles.css` — status bar + active-button styles.
- `README.md` — feature blurb + the "visible panes only" caveat.

**Edge cases / decisions.**
- Ctrl+C during broadcast sends SIGINT to every pane — that's the point, but
  verify it doesn't feel accidental when a raw pane is included.
- Terminal focus: broadcast only fires while the active pane is a terminal
  (never while the palette/search input has focus).
- `Ctrl+Shift+V` paste is bracketed-paste aware per session.
- Rename-overlay (`Ctrl+Shift+R`) input must not be broadcast.

**Verification.** Open an opencode pane + a raw pane, toggle broadcast, type
`echo hi` — both panes show `hi`. Confirm Ctrl+C hits both. Confirm exotic
keys (IME, dead keys) still reach the active pane. Confirm the toggle
survives workspace switches but resets on window close.

---

## 2. Pane maximize (zoom to fill the window)

**Problem.** With several splits open there's no quick way to temporarily make
one pane fill the window (tmux `Ctrl-b z`, iTerm "Zoom"). Dockview 7 already
supports this on the group/panel API (`maximize()` / `isMaximized()`); we
just never exposed it.

**Design.**

- New keybind **Zoom pane** (`Ctrl+Shift+M`, group "Layout") toggles the
  active panel: `panel.api.maximize()` / un-maximize when already maximized.
  (Verify exact method names against the installed `dockview-core@7.0.4`
  typings — `PanelApi` and the group API both expose maximize helpers.)
- Add the same action to the **context menu** (top-level entry, and on
  right-clicking a tab) and the **command palette** ("Zoom / unzoom pane").
- When a pane is maximized, hide the other panes' tabs? No — dockview handles
  the visual; only add a subtle affordance: the maximized tab shows a
  `⛶`-style marker or the sidebar Running list highlights the maximized pane.
- **Not serialized:** dockview does not persist maximized state in the layout
  JSON, so workspace save/restore naturally resets to un-maximized. Accept
  this (document it); do *not* try to persist it.

**Changes.**
- `src/main.ts` — `togglePaneMaximize()` (active panel), keybind dispatch,
  palette item, context-menu item.
- `src/keybinds.ts` — new `zoomPane` action (group "Layout", default
  `Ctrl+Shift+M`).
- `src/context-menu.ts` — entry (it already builds entries from app actions).
- `README.md` — feature blurb.

**Edge cases / decisions.**
- Closing the maximized pane should un-maximize cleanly (dockview handles it;
  verify no stuck overlay).
- Splitting while maximized: dockview un-maximizes on new panel; confirm the
  new panel gets focus as usual.
- Sidebar Running list / click-to-focus must still work while a pane is
  maximized (it operates on the same panel objects).

**Verification.** Split 2×2, maximize the bottom-right pane → fills window;
toggle again → restored. Close the maximized pane → other panes return.
Restart the app → layout restores un-maximized.

---

## 3. Reopen last closed session (session history)

**Problem.** A mis-click on ✕ (or `Ctrl+Shift+W`) closes a session — often an
agent mid-thought — and the user must re-create it manually: same agent,
possibly same worktree. Browsers set the expectation that "reopen closed tab"
exists.

**Design.**

- Keep a per-window stack (module-level, cap ~10) of recently closed
  sessions: `{ mode, cwd, title, worktreeWasAuto }`. Record on every teardown
  path — the `onDidRemovePanel` hook in `main.ts:2824`, and the parked-session
  kill path (`killParkedSession`).
- **Reopen** (`Ctrl+Shift+Z`, palette action "Reopen last closed session",
  maybe a "Reopen session…" sub-picker listing the stack like "Insert
  prompt…" via `openPaletteWith`):
  1. Pop the most recent entry.
  2. If it's an agent mode, resolve the working dir exactly like a restored
     layout does — **reuse `resolveWorktree(mode, cwd, name)`**: the saved
     worktree path is reused if `dir_exists` says it's still there, otherwise
     a fresh throwaway worktree is minted (`git_worktree_auto_create`). Raw
     sessions reopen in the launch dir (or saved cwd if still valid).
  3. Spawn through `addPanelWithMode` (or `openSessionAtPoint`) so titles,
     indicators, sidebar and notifications all work for free.
- A closed agent's worktree is force-deleted on close today; reopening with a
  fresh checkout is the expected behavior (note it in the README). We do *not*
  resurrect old PTYs — sessions are gone once closed.

**Changes.**
- `src/main.ts` — `closedSessions` stack, record in teardown paths, `reopenLastClosedSession()`, palette item(s), keybind dispatch.
- `src/keybinds.ts` — new `reopenSession` action (group "Sessions", default
  `Ctrl+Shift+Z`).
- `README.md` — feature blurb.

**Edge cases / decisions.**
- Window close: stack is per window, so it dies with the window (fine).
- Reopening an agent whose repo is gone: `resolveWorktree` already falls back
  to the launch dir — no special handling.
- Duplicate-close spam: stack dedupes consecutive identical entries.
- The "Reopen session…" sub-picker shows `mode icon + title (+ cwd)` with the
  newest first; activating an entry pops it.

**Verification.** Open an opencode pane, type something, close it, press
`Ctrl+Shift+Z` → a fresh opencode session opens in a *new* worktree with the
same title. Close a raw pane in a subdir → reopens in that cwd. Verify the
stack survives workspace switches (it's window-scoped).

---

## 4. Save / copy the session transcript

**Problem.** When an agent produces a long report or a build fails, users want
to grab the whole output — not just the visible scrollback — to paste into a
ticket or save for later. Scrollback is capped by xterm's buffer limit, so
reading the DOM buffer can miss early output.

**Design.**

- **Accumulate a per-session transcript in the frontend**, appended in
  `writeToTerminal` (`main.ts:637`) where every `pty://output` chunk already
  lands. Bound it (e.g. 2 MB per session, drop oldest chunks) so memory stays
  flat; store as a rolling array of strings to avoid repeated concatenation.
  (Frontend-side accumulation means the Rust backend needs no changes for
  capture — it already streams everything to JS.)
- **Actions** (palette, and a context-menu entry on the active pane):
  - *Copy transcript* — strip ANSI/OSC/CSI sequences (reuse/extend the
    existing escape-analysis helpers, `analyzeOutput`), join, put on the
    clipboard (existing `clipboard.ts` path). Cap applies (2 MB is fine for
    the clipboard).
  - *Save transcript…* — new Rust IPC `save_transcript(contents)` that opens
    a native save dialog via the **`tauri-plugin-dialog`** plugin (new
    dependency; default filename `hivefield-<tab-title>-<timestamp>.txt`),
    writes the de-escaped text, and returns the chosen path (or null when
    cancelled). The dialog replaces any need for path validation.
- Copy always works (no dialog); Save needs the plugin + a capability
  permission entry in `src-tauri/capabilities/`.

**Changes.**
- `src/main.ts` — transcript buffers per session, capture in `writeToTerminal`,
  strip-ANSI helper, palette + context-menu actions.
- `src-tauri/src/lib.rs` — `save_transcript` command + registration.
- `src-tauri/Cargo.toml`, `src-tauri/capabilities/*.json` — dialog plugin.
- `src/settings.ts` — (optional) a `maxTranscriptBytes` setting, default 2 MB.
- `README.md` — feature blurb.

**Edge cases / decisions.**
- Huge outputs: cap + "transcript truncated" note appended to the export.
- Binary output: strip control sequences; keep it best-effort (documents,
  not raw PTY byte dumps).
- Parked/background sessions keep accumulating? Yes — the session object
  lives in `sessions` regardless of parking, so capture keeps working; the
  sidebar already exposes those sessions.

**Verification.** Run `seq 1 100000` in a pane, close nothing, palette →
Save transcript… → file contains the full sequence with no `\x1b[...` noise.
Copy transcript → pastes clean text. Confirm the 2 MB cap truncates with a
notice.

---

## 5. Search upgrades: regex + whole-word

**Problem.** `Ctrl+Shift+F` already supports case toggling (`Alt+C`), but the
xterm SearchAddon also supports `regex` and `wholeWord` options
(`ISearchOptions` in `@xterm/addon-search@0.16`) that are unexposed.

**Design.**

- Extend `src/search.ts`:
  - New state `regex`, `wholeWord` (module scope, alongside `caseSensitive`).
  - `searchOptions(incremental)` adds `regex` and `wholeWord`.
  - `Alt+R` toggles regex (button `.*`), `Alt+W` toggles whole-word (button
    `\b` or "WW"), both styled like the existing `Aa` case button; active
    state highlighted.
  - Guard: regex mode must swallow invalid-pattern errors gracefully (the
    addon returns no matches; the existing `0/0` + red counter already
    communicates it).
- No new keybinds in the global registry — these are in-bar shortcuts like
  `Alt+C` today. Document in the bar's button tooltips and README.

**Changes.**
- `src/search.ts` — toggles, options, buttons, keydown handling.
- `src/styles.css` — button active styles (reuse the case-button classes).
- `README.md` — update the search feature blurb.

**Edge cases / decisions.**
- Regex with `^`/`$` interacts with per-line matching in the addon; document
  that matching is line-based.
- Whole-word + regex simultaneously: the addon supports both flags at once;
  let them compose.

**Verification.** `Ctrl+Shift+F`, type `foo\d+`, `Alt+R` → matches light up;
`Alt+W` with `foo` no longer matches `foobar`. Esc closes and returns focus.

---

## Sequencing

1. **Search upgrades (5)** — smallest, self-contained, zero new deps. Lands
   fast and greases the wheels.
2. **Pane maximize (2)** — small; exercises the dockview API surface.
3. **Reopen last closed session (3)** — reuses `resolveWorktree`; verifies
   the teardown-hook pattern that broadcast/status-bar will also need.
4. **Broadcast input (1)** — biggest frontend chunk; the status bar it adds
   becomes shared infrastructure.
5. **Save/copy transcript (4)** — adds the dialog plugin dependency; do it
   last so the dependency lands once.

Each lands as its own branch → rebase onto `master` → `--ff-only` merge →
branch/worktree cleanup, per the repo workflow.

## Non-goals (explicitly out of scope for now)

- Image/Sixel/kitty-graphics support (xterm.js has no first-party addon).
- SSH/connection bookmarks and a connection manager.
- tmux-style full session persistence across app restarts (PTYs die with the
  process; would need an external multiplexer).
- True multi-window broadcast (broadcast is per window by design).
