/**
 * Pure todo.txt parsing/serialization helpers (no DOM, no IPC).
 *
 * Split out of todotxt.ts so the grammar — completion marker, priority,
 * creation/completion dates — can be unit-tested without pulling in the
 * DOM/panel machinery. The panel module owns persistence (file reads/writes)
 * and rendering; everything here is a pure function of its inputs.
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

/** A parsed todo.txt task. */
export interface TodoTask {
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
export function todayStr(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse one todo.txt line into a structured task. The grammar is:
 *   [x] [(P)] [YYYY-MM-DD] [YYYY-MM-DD] <description>
 */
export function parseLine(line: string): TodoTask {
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
export function serializeTask(t: TodoTask): string {
  const parts: string[] = [];
  if (t.done) parts.push("x");
  if (t.priority) parts.push(`(${t.priority})`);
  if (t.completed && t.done) parts.push(t.completed);
  if (t.created) parts.push(t.created);
  else if (t.done && !t.completed && !t.created) parts.push(todayStr());
  if (t.text) parts.push(t.text);
  return parts.join(" ");
}

/**
 * Toggle a task's completion state in place: add/remove the `x ` prefix and
 * set/clear the completion date (and stamp a creation date when one is
 * missing). Returns the same array for chaining.
 */
export function toggleTask(tasks: TodoTask[], index: number): TodoTask[] {
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
  return tasks;
}

/**
 * Append a new task to the end of the list (in place): parse the input text,
 * stamp a creation date when missing, serialize, and push. Blank input (no
 * description after parsing) is ignored. Returns the same array.
 */
export function addTask(tasks: TodoTask[], text: string): TodoTask[] {
  const t = parseLine(text.trim());
  if (!t.text) return tasks; // ignore blank input
  if (!t.created) t.created = todayStr();
  t.raw = serializeTask(t);
  tasks.push(t);
  return tasks;
}
