# Plan: Switch the renderer back to xterm.js (drop Ghostty canvas)

**Status:** proposal — reviewed against the current tree (`HEAD` = `184b67b` on
`dev`) and the pre-switch xterm.js state (`0355e48^` / `9efb278^`). Nothing in
this plan has been implemented yet.

---

## 1. Context: why we're here

The app is a Tauri v2 terminal multiplexer. Up until commit `0355e48`
("refactor: remove xterm.js, use ghostty canvas exclusively") the terminal
frontend was **xterm.js** (`@xterm/xterm` 5.5.0 + Fit/Search/Unicode11 addons),
rendering the `pty://output` byte stream pushed from Rust. A parallel
experiment (`9efb278`, "feat: ghostty-based terminal rendering pipeline") added
a Rust-side VT emulator (`vtcode-ghostty-core`) that sends full-screen
`ghostty://cells` snapshots to a `<canvas>` renderer (`GhosttyCanvas`), and
`0355e48` made that the *only* renderer.

The canvas renderer is a significant regression from the xterm.js era:

| Capability | xterm.js (pre-`0355e48`) | GhosttyCanvas (current) |
|---|---|---|
| Scrollback | 10k lines, wheel/PageUp/PageDown, follow-pinning | **none** — canvas draws only the visible screen |
| Text selection / copy | built-in, Ctrl+Shift+C, context menu | stubbed (`getSelection()` → `""`, `hasSelection()` → `false`); menus show Copy always-disabled |
| Find in terminal (Ctrl+Shift+F) | SearchAddon with decorations | stubbed — `runSearch()` hardcodes `updateCount(0, 0)`, no highlights |
| Keyboard input | full xterm translation (Alt, Ctrl, function keys, IME, brackets) | hand-rolled `_onKeyDown` subset — no Alt/`Ctrl+letter` except Ctrl+C, no IME, no bracketed paste |
| Mouse | wheel scroll, click-to-focus, drag-select | none (no listeners) |
| Links | xterm URL detection + Ctrl+click `open_url` + hover tooltip | gone |
| Unicode | Unicode11Addon | whatever `fillText` does per-cell |
| Fonts | ligatures, weight, line-height, letter-spacing, contrast | weight + size only |
| Cursor | block/outline per focus, blink | block + blink, no outline state |
| Pending-output replay | `pendingOutputs` buffer in listeners.ts | buffer retained, but nothing writes it to a view |

The Rust side also pays a tax for the ghostty pipeline: every output chunk
feeds a second full VT emulator (`GhosttyState`), and every frame serializes
the **entire grid** to the webview — visible in the perf workarounds already
piled up (`070a1de` throttle, `184b67b` sub-pixel gaps).

**Goal:** revert the renderer path to xterm.js while keeping the surrounding
architecture (multi-window, workspace parking, sidebar, titles, agents, splash)
exactly as it is. The pre-switch code is intact in git history (`0355e48^`), so
this is mostly a careful, file-by-file restore — not a rewrite.

### Definition of done

- `bun run build`, `bun test`, `bunx tsc --noEmit` green; `cargo test` in
  `src-tauri/` green.
- New session renders with xterm.js: scrollback works (wheel/PageUp/PageDown +
  follow pinning), selection + copy work, Ctrl+Shift+F finds and highlights,
  full keyboard input incl. Alt/function keys, links open on Ctrl+click,
  cursor focus/outline states are honest across workspace parking.
- `ghostty://cells` / `GhosttyCanvas` / `GhosttyState` fully removed (frontend
  and Rust), `vtcode-ghostty-core` dropped from `Cargo.toml`/`Cargo.lock`.

---

## 2. Where the current ghostty wiring lives

**Frontend (all of it must go or be reverted):**

- `src/ghostty-canvas.ts` — the whole `GhosttyCanvas` class + `registerGhosttyCanvas` /
  `unregisterGhosttyCanvas` / `initGhosttyListener` + `canvases` map. **Delete.**
- `src/state.ts` — `SessionEntry.canvas: GhosttyCanvas` (+ stale `ghostty?`
  field), `canvasSessions` WeakMap, `import type { GhosttyCanvas }`. Restore
  `terminal` / `fitAddon` / `searchAddon` fields + `terminalSessions` WeakMap.
- `src/sessions.ts` — `createTerminalComponent` is ghostty-based (create
  canvas, `canvas.fit()`, `resizePty`, parked-restore moves canvas element).
  Restore xterm creation (`createTerminal()`), `sync()/syncWhenReady()`,
  `onData` → `pty_write`, `onTitleChange` (input-line titles), scroll
  follow/wheel handlers, parked-restore via terminal element.
- `src/terminal.ts` — already gutted: only `hexToRgba`, `applyUiTheme`,
  `ensureTerminalFont`, `terminalFontReady` remain. Restore xterm creation,
  `applyTerminalSettings`, `writeToTerminal`, `syncSize`, `isAtBottom`,
  `followState`/`isFollowing`/`setFollowing`, `syncTerminalCursorFocus`,
  `setupLinks`, `applyFontLigatures`.
- `src/listeners.ts` — currently drops text on the floor for live sessions
  ("ghostty canvas auto-renders") and never replays `pendingOutputs` into a
  terminal. Restore `writeToTerminal(entry.terminal, text)` and the
  `[process exited with code N]` note on exit.
- `src/main.ts` — `initGhosttyListener()` import/call, `entry.canvas.applyFont`
  in the settings subscriber, `entry.canvas.element.remove()` in
  `onDidRemovePanel`, `activeSessionEntry()?.canvas.focus()`. Restore the
  xterm equivalents (`applyTerminalSettings` + `syncSize`, `terminal.dispose()`,
  `syncTerminalCursorFocus()` on active-panel change / after restore).
- `src/bell.ts` — `handleBell(canvas: GhosttyCanvas)` keyed via `canvasSessions`.
  Restore `handleBell(terminal: Terminal)` keyed via `terminalSessions`.
- `src/search.ts` — `SearchableTerminal { canvas }`; `runSearch()` stubbed.
  Restore SearchAddon-based `findNext`/`findPrevious` + decorations
  (`matchDecorations()` already exists and is theme-derived).
- `src/menus.ts` — `entry.canvas.hasSelection()/getSelection()/write()`.
  Restore `entry.terminal.hasSelection()/getSelection()/paste()`.
- `src/keyboard.ts` — paste via `entry.canvas.write()`, copy stub (`""`).
  Restore `entry.terminal.paste()` / `entry.terminal.getSelection()`.
- `src/palette-items.ts` — snippet insert + pane focus via `canvas`.
  Restore `entry.terminal.paste()` / `terminal.focus()`.
- `src/sidebar.ts` — click-to-focus via `entry.canvas.focus()`, park-time
  `entry.canvas.blur()`. Restore `entry.terminal.focus()` / `.blur()`.
- `src/styles.css` — `.terminal-panel .xterm` rule still exists; add back
  `.xterm` sizing/selection styles if needed. Ghostty container styles are
  inline in `ghostty-canvas.ts` (die with the file).

**Rust (all of it must go):**

- `src-tauri/src/ghostty_render.rs` — entire `GhosttyState` module. **Delete.**
- `src-tauri/src/pty.rs` — `GhosttyState::create()` in `spawn`, ghostty
  `feed_bytes`/`flush` in the reader loop, `ready`-gated flush.
- `src-tauri/src/lib.rs` — `mod ghostty_render;`, `GhosttyState` params on
  `pty_resize`/`pty_kill`, `.manage(GhosttyState::default())`.
- `src-tauri/Cargo.toml` — drop `vtcode-ghostty-core = "0.128.4"`;
  `Cargo.lock` drops it on next build.

**Still-present xterm deps (convenient — no package.json change needed):**
`@xterm/xterm`, `@xterm/addon-fit`, `@xterm/addon-search`,
`@xterm/addon-unicode11` are still in `package.json` + `bun.lock` (removal in
`0355e48` only touched source). `src/themes.ts` still imports `ITheme` from
`@xterm/xterm` and compiles today. `index.html` needs no change.

---

## 3. Recommended approach

Two viable paths; **B is recommended** because the modules have diverged less
than the diff suggests and history gives us exact, known-good code.

### Option A — `git revert 0355e48` (not recommended as-is)

`git revert 0355e48` cleanly restores the xterm.js frontend, but it **also
reintroduces the parallel ghostty canvas** (`9efb278` created it before
`0355e48`; the revert would restore `sessions.ts`'s "create GhosttyCanvas
alongside xterm" block). Net effect: canvas code remains, and the pre-`9efb278`
Rust state is *not* restored (reverting `0355e48` does not remove
`GhosttyState` from `pty.rs`/`lib.rs`/`Cargo.toml` — those hunks landed in
`9efb278`). So A needs follow-up surgery on top of the revert anyway:

- strip the `GhosttyCanvas` creation/`entry.ghostty`/`registerGhosttyCanvas`
  block back out of `sessions.ts`/`state.ts`,
- delete `src/ghostty-canvas.ts`,
- revert/remove `9efb278`'s Rust hunks (`git revert 9efb278` on top would then
  cleanly drop `ghostty_render.rs`, the `pty.rs` feed, `lib.rs` manage/params,
  and the `Cargo.toml` dep).

`git revert 0355e48 && git revert 9efb278` is a *legitimate* variant of A: the
two reverts compose (they touch disjoint files except `sessions.ts`/`state.ts`,
which A's revert re-introduces and B's revert then removes). Order matters:
revert `0355e48` first, then `9efb278`. This is fast but produces a
checkpoint that is briefly inconsistent between the two reverts if run as two
separate commits, and it drags in **pre-`0355e48` drift** (the tree at
`0355e48^` differs from today's HEAD by ~6 ghostty bugfix commits that must be
*kept*: `59dd63e` tabindex, `587e0fd` cursor, `070a1de` throttle, `184b67b`
gaps, plus `1dbc943` — all canvas-only, so reverting them away is correct).

### Option B — restore the xterm.js modules from history, keep everything else (recommended)

Manually restore each file's xterm.js shape from `0355e48^` (the known-good
pre-removal state), then **delete** the ghostty-only pieces that
post-date it. Because the frontend modules are cohesive, per-file restores are
small and reviewable. Draft order:

1. `src/terminal.ts` ← `git show 0355e48^:src/terminal.ts`
2. `src/state.ts` — restore `terminal`/`fitAddon`/`searchAddon` fields,
   `terminalSessions` WeakMap, drop `canvas`/`ghostty`/`canvasSessions`.
3. `src/sessions.ts` ← `0355e48^` version, minus the
   `// Create ghostty canvas renderer alongside xterm` block and the
   `GhosttyCanvas` imports/`entry.ghostty` references.
4. `src/listeners.ts` ← `0355e48^` version (restores `writeToTerminal` +
   exit note).
5. `src/bell.ts`, `src/search.ts`, `src/menus.ts`, `src/keyboard.ts`,
   `src/palette-items.ts`, `src/sidebar.ts` ← `0355e48^` versions (each is a
   small `canvas`→`terminal` swap; menus/keyboard/palette-items also restore
   real selection/copy/paste).
6. `src/main.ts` — restore the xterm wiring lines (settings subscriber,
   `onDidRemovePanel`, active-panel-change `syncTerminalCursorFocus()`,
   `continueFromSplash` reconcile, drop `initGhosttyListener`).
7. `src/ghostty-canvas.ts` — **delete**.
8. Rust: `src-tauri/src/lib.rs` ← `9efb278^` version of `pty_resize`/
   `pty_kill`/`manage`/`mod` list; `src-tauri/src/pty.rs` ← `9efb278^` reader
   loop + `spawn` (drop ghostty feed/create); `src-tauri/src/ghostty_render.rs`
   — **delete**; `src-tauri/Cargo.toml` drop `vtcode-ghostty-core`.
9. `src/styles.css` — restore `.terminal-panel .xterm` sizing if the current
   `.terminal-panel` overflow rule doesn't cover it (it already has
   `overflow: hidden` + `.xterm { width/height: 100% }` — verify).

> **Merge strategy:** `0355e48^` is 6 commits behind HEAD *and* contains
> unrelated pre-`0355e48` history; do **not** `git checkout 0355e48^ -- <file>`
> blindly for files that gained unrelated changes after the removal
> (especially `sessions.ts`, `state.ts`, `main.ts`, `sidebar.ts`). Prefer
> `git show 0355e48^:<file>` as a reference, then apply the xterm-shaped diff
> onto the current file with `edit`, preserving post-removal fixes (e.g. the
> parked-session re-keying, `panelStatus`, `panelToSession` id mapping — all
> still needed).

---

## 4. Task breakdown (landing as one branch → one commit)

A single branch off `dev`, one commit at the end (this is one atomic
"renderer" unit of work; splitting it would leave the tree broken at each
intermediate commit). Order within the branch:

1. **Restore `src/terminal.ts`** (xterm creation, settings, fit, scroll-follow,
   cursor focus, links, ligatures) — module compiles standalone against the
   still-installed xterm deps.
2. **Restore `src/state.ts`** — swap `canvas` → `terminal/fitAddon/searchAddon`,
   `canvasSessions` → `terminalSessions`.
3. **Restore `src/sessions.ts`** — xterm-based panel component (create, open,
   onData → pty_write, onTitleChange, wheel/PageUp follow, parked restore),
   dropping the ghostty canvas block.
4. **Restore `src/listeners.ts`** — write output into terminals + replay
   `pendingOutputs` + exit note.
5. **Swap the consumer modules** — `bell.ts`, `search.ts`, `menus.ts`,
   `keyboard.ts`, `palette-items.ts`, `sidebar.ts` (canvas → terminal APIs;
   re-enable selection/copy/paste and SearchAddon).
6. **Rewire `src/main.ts`** — settings subscriber, remove-panel teardown,
   active-panel-change cursor sync, splash restore; drop ghostty listener init.
7. **Delete `src/ghostty-canvas.ts`** + remove its CSS if any (none in
   `styles.css`; inline styles die with the file).
8. **Rust** — restore `pty.rs`/`lib.rs` to pre-ghostty shape, delete
   `ghostty_render.rs`, drop the `Cargo.toml` dep, let `cargo test` refresh
   `Cargo.lock`.
9. **Verify** (below), then `git add` + commit (subject suggestion:
   `refactor: switch terminal renderer back to xterm.js`), `--ff-only` merge
   to `dev`, remove the branch.

### Files touched (summary)

| File | Action |
|---|---|
| `src/ghostty-canvas.ts` | delete |
| `src-tauri/src/ghostty_render.rs` | delete |
| `src/terminal.ts` | restore xterm version (`0355e48^`) |
| `src/state.ts` | restore xterm fields |
| `src/sessions.ts` | restore xterm component (drop ghostty block) |
| `src/listeners.ts` | restore writeToTerminal path |
| `src/main.ts` | restore xterm wiring |
| `src/bell.ts`, `src/search.ts`, `src/menus.ts`, `src/keyboard.ts`, `src/palette-items.ts`, `src/sidebar.ts` | canvas → terminal swaps |
| `src/styles.css` | verify `.xterm` sizing; no ghostty rules to remove |
| `src-tauri/src/lib.rs`, `src-tauri/src/pty.rs` | restore pre-ghostty shape |
| `src-tauri/Cargo.toml` (+ lock via build) | drop `vtcode-ghostty-core` |

---

## 5. Verification checklist

**Build/type/test:**
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run build` succeeds
- [ ] `bun test` passes (input-line, keybinds, modes, fuzzy, registry-docs,
      settings tests — these don't touch the renderer but must stay green)
- [ ] `cargo test` in `src-tauri/` passes (pty tests use `MockRuntime`; they
      don't reference ghostty once `pty.rs` is restored)

**Manual (dev build: `bun run dev:no-reload` or `tauri dev`):**
- [ ] New raw + agent sessions render, prompt visible, output streams live
- [ ] **Scrollback**: `seq 1 5000` → wheel up/down works, PageUp/PageDown,
      typing re-pins to bottom, no "stuck scroll" freeze (restored
      `followState` machinery)
- [ ] **Selection/copy**: drag-select text, Ctrl+Shift+C copies, context menu
      Copy enabled + copies; Ctrl+Shift+V pastes bracketed-paste aware
- [ ] **Find**: Ctrl+Shift+F highlights matches, ↑/↓ navigate, `Alt+C` case
      toggle, count reads `n/m`; theme change while open re-colors
- [ ] **Keyboard**: Alt+letter, function keys, Ctrl+C SIGINT, Ctrl+L clear,
      Tab completion, arrow keys all reach the shell; IME/dead keys don't
      corrupt the line
- [ ] **Links**: Ctrl+click a URL opens the browser; hover shows tooltip
- [ ] **Cursor**: filled in active pane, outline in inactive; survives
      workspace park/restore (restored `syncTerminalCursorFocus` + explicit
      blur on park)
- [ ] **Parking/restore**: switch workspaces, come back — scrollback intact,
      no garbled reflow (restored `syncSize` zero-size guard + font gate)
- [ ] **Titles**: OSC 133 input-line titles + agent completion indicators still
      work (listeners restored)
- [ ] **Bell**: `echo -e '\a'` plays tone + background notification
- [ ] **Multi-window**: session output routes to the spawning window
      (unchanged — owner-label logic in `pty.rs` is preserved)

---

## 6. Risks / things to watch

1. **Divergence between `0355e48^` and HEAD.** Post-removal commits changed
   `sessions.ts`/`state.ts`/`main.ts`/`sidebar.ts` (parked-session re-keying
   under `parked:<id>`, `panelToSession` id mapping, `notified` reset logic,
   `setupSidebarDndFallback`). Restore the *xterm-shaped* code, not the whole
   old file, and re-apply the parked/status changes that landed after the
   removal — they are orthogonal to the renderer and must survive.
2. **The `pty://output` → `pendingOutputs` handoff.** The old frontend
   buffered output in `listeners.ts` (pendingOutputs) until the terminal was
   registered, *and* the Rust side gates emission on `mark_ready`. Restoring
   the old listeners.ts restores the frontend replay; keep both halves in
   sync (the Rust `mark_ready` path is untouched by the revert).
3. **`Cargo.lock` churn.** Dropping `vtcode-ghostty-core` may leave stale
   transitive entries if cargo doesn't prune; run `cargo update`/`cargo check`
   and confirm the lock diff is limited to ghostty-related crates.
4. **CSS regression risk is low** — `.terminal-panel .xterm` sizing rule still
   exists; but confirm `.xterm` has `width/height: 100%` and the
   `.terminal-panel` keeps `overflow: hidden` (it does).
5. **The 6 ghostty bugfix commits** (`59dd63e`, `587e0fd`, `1dbc943`,
   `070a1de`, `184b67b`, and `0355e48` itself) fix canvas-only bugs and must
   **not** be preserved in the new renderer path — reverting/omitting them is
   correct. Do not cherry-pick any of them into the xterm work.
6. **Feature plan drift.** `docs/FEATURE_PLAN.md` (regex search, broadcast,
   maximize, reopen, transcript) was written against the xterm.js architecture
   and its "status" note predates the ghostty experiment. After the switchback
   the plan's assumptions hold again; the transcript feature's
   "capture in `writeToTerminal`" hook point reappears. No plan edit is
   required for this switchback itself, but note it in the commit body.

---

## 7. Out of scope (for this switchback)

- Re-adding Sixel/kitty-graphics, SSH bookmarks, session persistence across
  restarts, or multi-window broadcast (non-goals from `FEATURE_PLAN.md`).
- Keeping the ghostty renderer available behind a flag. The request is a
  *switch back*; a flag would double the maintenance surface and the canvas
  path has no unique features to preserve. If a flag is later wanted, the
  xterm and canvas paths are now cleanly separated by the module boundary
  (`terminal.ts` vs `ghostty-canvas.ts`) and can be reintroduced as a
  `SessionEntry.renderer` variant.
