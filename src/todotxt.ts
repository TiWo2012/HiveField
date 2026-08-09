/**
 * Custom todo.txt renderer: a non-terminal panel that reads, displays, and
 * edits a todo.txt file. Each task is an interactive row — click the checkbox
 * to toggle completion, type in the input bar to add a new entry, right-click
 * a task to send it to a coding agent. All changes are written back to the
 * file immediately.
 *
 * Format: http://todotxt.org/
 *   x (A) 2024-01-01 2024-01-02 Call Mom @phone +family
 *   │  │   │         │          │        │       │
 *   │  │   │         │          │        │       └─ project tag
 *   │  │   │         │          │        └──────── context tag
 *   │  │   │         │          └───────────────── description
 *   │  │   │         └──────────────────────────── completion date
 *   │  │   └────────────────────────────────────── creation date (optional)
 *   │  └────────────────────────────────────────── priority (optional, A-Z)
 *   └───────────────────────────────────────────── completion marker
 */

import { invoke } from "@tauri-apps/api/core";
import { addPanelWithMode } from "./sessions";
import { panelToSession } from "./state";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { sessionModes } from "./modes";
import {
  addTask as addTaskPure,
  parseTasks,
  tasksKey,
  toggleTask as toggleTaskPure,
  type TodoTask,
} from "./todotxt-core";

/** Build the "Send task to agent" right-click submenu for a given task. */
function buildSendTaskMenu(taskText: string): ContextMenuItem[] {
  return sessionModes()
    .filter((s) => s.mode !== "raw" && s.mode !== "todotxt")
    .map(({ mode, label, icon }) => ({
      label,
      icon,
      run: () => {
        // Target the session of the panel we just created. Scanning for
        // *any* session with this mode would match an older session of the
        // same agent (whose task already finished, or which has exited), so
        // the text would land in the wrong place on a second send.
        const panel = addPanelWithMode(mode);
        const panelId = panel.id;
        let attempts = 0;
        const tryWrite = () => {
          const sessionId = panelToSession.get(panelId);
          if (sessionId === undefined) {
            if (++attempts < 40) setTimeout(tryWrite, 50);
            return;
          }
          // PTY is ready, but the agent hasn't started yet — wait
          // for it to boot so the text doesn't land at the shell
          // prompt before the autorun command runs.
          setTimeout(() => {
            // \r (carriage return), not \n: TUI agents (pi, opencode,
            // …) run stdin in raw mode where Enter is \r; a bare \n
            // maps to shift+enter under the kitty keyboard protocol and
            // just inserts a newline instead of submitting.
            invoke("pty_write", { sessionId, data: taskText + "\r" }).catch(
              (err) => console.error("failed to write task to agent session", err)
            );
          }, 3000);
        };
        tryWrite();
      },
    }));
}

/**
 * Toggle a task's completion: add/remove the `x ` prefix, set/clear the
 * completion date, and persist the file.
 */
async function toggleTask(
  tasks: TodoTask[],
  index: number,
  filePath: string
): Promise<TodoTask[]> {
  toggleTaskPure(tasks, index);
  await writeTasks(tasks, filePath);
  return tasks;
}

/**
 * Add a new task at the end of the list and persist.
 */
async function addTask(
  tasks: TodoTask[],
  text: string,
  filePath: string
): Promise<TodoTask[]> {
  addTaskPure(tasks, text);
  await writeTasks(tasks, filePath);
  return tasks;
}

/** Persist the current task list to the todo.txt file (best-effort). */
async function writeTasks(tasks: TodoTask[], filePath: string): Promise<void> {
  const content = tasks.map((t2) => t2.raw).join("\n") + "\n";
  await invoke("file_write", { path: filePath, content }).catch((err) =>
    console.error("failed to write todo.txt", err)
  );
}

/**
 * Set up the todo.txt panel inside `element`. Reads `todo.txt` from `cwd`,
 * renders every task as an interactive row, and wires up the input bar.
 */
export async function setupTodoTxtPanel(
  element: HTMLElement,
  cwd: string,
  onFocus: () => void
): Promise<void> {
  element.classList.add("todotxt-panel");

  const filePath = `${cwd}/todo.txt`;

  // --- read the file ---
  let raw: string;
  try {
    raw = await invoke<string>("file_read", { path: filePath });
  } catch {
    // File doesn't exist yet: start empty.
    raw = "";
  }
  let tasks: TodoTask[] = parseTasks(raw);

  // --- build DOM ---
  const list = document.createElement("div");
  list.className = "todotxt-list";

  const inputRow = document.createElement("div");
  inputRow.className = "todotxt-input-row";
  const inputIcon = document.createElement("span");
  inputIcon.className = "todotxt-input-icon";
  inputIcon.textContent = "+";
  const input = document.createElement("input");
  input.className = "todotxt-input";
  input.type = "text";
  input.placeholder = "Add a task…";
  inputRow.append(inputIcon, input);
  element.append(list, inputRow);

  // --- render helpers ---
  function renderTask(task: TodoTask, i: number): HTMLElement {
    const row = document.createElement("div");
    row.className = "todotxt-task";
    if (task.done) row.classList.add("done");

    // Checkbox
    const cb = document.createElement("span");
    cb.className = "todotxt-checkbox";
    cb.textContent = task.done ? "☑" : "☐";
    cb.addEventListener("click", async (e) => {
      e.stopPropagation();
      tasks = await toggleTask(tasks, i, filePath);
      refreshList();
    });

    // Priority badge
    const prio = document.createElement("span");
    prio.className = "todotxt-priority";
    prio.textContent = task.priority ? `(${task.priority})` : "";

    // Text
    const desc = document.createElement("span");
    desc.className = "todotxt-desc";
    desc.textContent = task.text || task.raw;

    // Highlight @contexts and +projects
    const html = task.text.replace(
      /(\+\w+|@\w+)/g,
      '<span class="todotxt-tag">$1</span>'
    );
    if (html !== task.text) desc.innerHTML = html;

    // Dates
    const dates = document.createElement("span");
    dates.className = "todotxt-dates";
    const dateParts: string[] = [];
    if (task.created) dateParts.push(task.created);
    if (task.completed) dateParts.push(`→ ${task.completed}`);
    dates.textContent = dateParts.join(" ");

    row.append(cb, prio, desc, dates);

    // Right-click → send task to agent
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // The task text to send omits the priority prefix to avoid confusing
      // the agent with todo.txt markup.
      const taskText = task.text || task.raw.replace(/^x\s+/, "").replace(/^\([A-Z]\)\s+/, "");
      const menu: ContextMenuItem[] = [
        {
          label: "Send task to agent",
          icon: "↗",
          submenu: buildSendTaskMenu(taskText),
        },
      ];
      showContextMenu(menu, e.clientX, e.clientY);
    });

    return row;
  }

  function refreshList(): void {
    list.replaceChildren();
    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "todotxt-empty";
      empty.textContent = "No tasks yet — add one below";
      list.appendChild(empty);
      return;
    }
    for (let i = 0; i < tasks.length; i++) {
      list.appendChild(renderTask(tasks[i], i));
    }
  }

  refreshList();

  // --- input handling ---
  input.addEventListener("keydown", async (e) => {
    if (e.key === "Enter" && input.value.trim()) {
      e.preventDefault();
      const text = input.value;
      input.value = "";
      tasks = await addTask(tasks, text, filePath);
      refreshList();
    }
  });

  // Focus the input when the panel is activated.
  element.addEventListener("click", () => {
    onFocus();
    input.focus();
  });

  // Initial focus
  setTimeout(() => input.focus(), 50);

  // --- poll for external edits ---
  // Other processes (a coding agent ticking off its task, an editor, a git
  // checkout…) may rewrite todo.txt behind this panel's back. Re-read the
  // file every 30s and refresh the list when the on-disk content diverges
  // from what's shown. Local edits already write the file immediately, so a
  // poll that reads back identical content is a no-op — no flicker, and the
  // input bar (which lives outside the list) keeps focus while typing.
  const POLL_MS = 30_000;

  async function pollForUpdates(): Promise<void> {
    // Panel closed (dockview removed the element): stop polling.
    if (!element.isConnected) {
      clearInterval(pollTimer);
      return;
    }
    let raw: string;
    try {
      raw = await invoke<string>("file_read", { path: filePath });
    } catch {
      // Unreadable (transient error or file deleted): keep showing the
      // current list rather than wiping it on a spurious failure.
      return;
    }
    const fresh = parseTasks(raw);
    if (tasksKey(fresh) === tasksKey(tasks)) return;
    tasks = fresh;
    refreshList();
  }

  const pollTimer = window.setInterval(pollForUpdates, POLL_MS);
}
