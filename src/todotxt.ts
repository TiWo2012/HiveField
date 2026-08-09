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
import { getApi, panelToSession, sessions } from "./state";
import { showContextMenu, type ContextMenuItem } from "./context-menu";
import { sessionModes } from "./modes";

/** A parsed todo.txt task. */
interface TodoTask {
  /** Raw line from the file. */
  raw: string;
  /** Whether the task is completed (starts with `x `). */
  done: boolean;
  /** Priority letter A-Z, or null. */
  priority: string | null;
  /** Creation date YYYY-MM-DD, or null. */
  created: string | null;
  /** Completion date YYYY-MM-DD, or null (only when done). */
  completed: string | null;
  /** The task description (everything after priority/dates). */
  text: string;
}

/** Today's date in YYYY-MM-DD (local timezone, what todo.txt apps expect). */
function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one todo.txt line into a structured task. The grammar is:
 *   [x] [(P)] [YYYY-MM-DD] [YYYY-MM-DD] <description>
 */
function parseLine(line: string): TodoTask {
  let rest = line.trim();
  const raw = rest;

  // Completion marker.
  let done = false;
  let completed: string | null = null;
  if (rest.startsWith("x ")) {
    done = true;
    rest = rest.slice(2).trimStart();
  }

  // Priority (A-Z) in parens.
  let priority: string | null = null;
  const prioMatch = /^\(([A-Z])\)\s+/.exec(rest);
  if (prioMatch) {
    priority = prioMatch[1];
    rest = rest.slice(prioMatch[0].length);
  }

  // One or two dates.
  let created: string | null = null;
  const firstWord = rest.split(/\s+/, 1)[0];
  if (DATE_RE.test(firstWord)) {
    created = firstWord;
    rest = rest.slice(firstWord.length).trimStart();
    const secondWord = rest.split(/\s+/, 1)[0];
    if (DATE_RE.test(secondWord)) {
      if (done) {
        completed = created;
        created = secondWord;
      } else {
        // Two dates on an incomplete task: treat first as creation.
        completed = null;
      }
      rest = rest.slice(secondWord.length).trimStart();
    }
  }

  return { raw, done, priority, created, completed, text: rest };
}

/**
 * Re-serialize a task back to a todo.txt line reflecting its current state.
 */
function serializeTask(t: TodoTask): string {
  const parts: string[] = [];
  if (t.done) parts.push("x");
  if (t.priority) parts.push(`(${t.priority})`);
  if (t.completed && t.done) parts.push(t.completed);
  if (t.created) parts.push(t.created);
  else if (t.done && !t.completed && !t.created) parts.push(todayStr());
  if (t.text) parts.push(t.text);
  return parts.join(" ");
}

/** Build the "Send task to agent" right-click submenu for a given task. */
function buildSendTaskMenu(taskText: string): ContextMenuItem[] {
  return sessionModes()
    .filter((s) => s.mode !== "raw" && s.mode !== "todotxt")
    .map(({ mode, label, icon }) => ({
      label,
      icon,
      run: () => {
        addPanelWithMode(mode);
        let attempts = 0;
        const tryWrite = () => {
          const panels = getApi().panels;
          for (const panel of [...panels].reverse()) {
            const sessionId = panelToSession.get(panel.id);
            if (sessionId === undefined) continue;
            const entry = sessions.get(sessionId);
            if (entry?.mode !== mode) continue;
            // PTY is ready, but the agent hasn't started yet — wait
            // for it to boot so the text doesn't land at the shell
            // prompt before the autorun command runs.
            setTimeout(() => {
              invoke("pty_write", { sessionId, data: taskText + "\n" }).catch(
                (err) => console.error("failed to write task to agent session", err)
              );
            }, 3000);
            return;
          }
          if (++attempts < 40) setTimeout(tryWrite, 50);
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
  const t = tasks[index];
  if (!t) return tasks;
  if (t.done) {
    t.done = false;
    t.completed = null;
  } else {
    t.done = true;
    t.completed = todayStr();
    if (!t.created) t.created = todayStr();
  }
  t.raw = serializeTask(t);
  const content = tasks.map((t2) => t2.raw).join("\n") + "\n";
  await invoke("file_write", { path: filePath, content }).catch((err) =>
    console.error("failed to write todo.txt", err)
  );
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
  const t = parseLine(text.trim());
  if (!t.text) return tasks; // ignore blank input
  if (!t.created) t.created = todayStr();
  t.raw = serializeTask(t);
  tasks.push(t);
  const content = tasks.map((t2) => t2.raw).join("\n") + "\n";
  await invoke("file_write", { path: filePath, content }).catch((err) =>
    console.error("failed to write todo.txt", err)
  );
  return tasks;
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
  let tasks: TodoTask[] = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parseLine);

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
}
