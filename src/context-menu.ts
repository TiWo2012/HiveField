/**
 * Styled, keyboard-navigable context menu (right-click).
 *
 * A small dependency-free menu for right-click actions on terminal panes,
 * tabs, and split gutters. Supports nested submenus (hover or → to open,
 * ←/Esc to go back), icons, right-aligned shortcut hints, danger items, and
 * separators. Menus clamp to the viewport and are fully keyboard-navigable:
 * ↑/↓ move, →/Enter open/activate, ←/Esc close.
 *
 * The module is deliberately decoupled from the app: callers build a tree of
 * `ContextMenuItem`s and call `showContextMenu(items, x, y)`. Clicking
 * outside, pressing a non-navigation key, window blur, or a resize dismisses
 * the menu; a non-navigation keystroke is allowed to fall through (the
 * terminal keeps focus and receives it).
 */

export interface ContextMenuItem {
  /** Row label (not needed on separator rows). */
  label?: string;
  /** Leading icon glyph (e.g. "✦"). */
  icon?: string;
  /** Right-aligned keyboard hint (e.g. "Ctrl+Shift+F"). */
  shortcut?: string;
  /** Nested menu, opened by hover / → / Enter. */
  submenu?: ContextMenuItem[];
  /** Runs when the item is activated (leaf items only). */
  run?: () => void;
  /** Greyed out and unselectable. */
  disabled?: boolean;
  /** Destructive action, rendered in red. */
  danger?: boolean;
  /** Render a horizontal divider instead of a row. */
  separator?: boolean;
}

interface MenuLevel {
  el: HTMLElement;
  items: ContextMenuItem[];
  /** Index of the highlighted row, or -1 for none. */
  activeIndex: number;
  /** Index of the row whose submenu is currently open (if any). */
  openChildIndex?: number;
}

let root: HTMLElement | null = null;
let stack: MenuLevel[] = [];
let open = false;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

/** Minimum space kept between a menu and the viewport edge. */
const EDGE_MARGIN = 8;
/** Delay (ms) before a hovered parent row opens its submenu. */
const OPEN_DELAY_MS = 90;
/** Grace period (ms) before a hovered-out parent closes its submenu. */
const CLOSE_DELAY_MS = 200;

function clearHoverTimers(): void {
  if (openTimer !== undefined) {
    clearTimeout(openTimer);
    openTimer = undefined;
  }
  if (closeTimer !== undefined) {
    clearTimeout(closeTimer);
    closeTimer = undefined;
  }
}

function ensureRoot(): HTMLElement {
  if (root) return root;
  root = document.createElement("div");
  root.className = "ctx-menu-root";
  document.body.appendChild(root);
  return root;
}

/** Build the DOM for one menu level, skipping separators in the row list. */
function buildMenu(items: ContextMenuItem[]): { el: HTMLElement; items: ContextMenuItem[] } {
  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");
  const rowItems: ContextMenuItem[] = [];
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement("div");
      sep.className = "ctx-menu-separator";
      sep.setAttribute("role", "separator");
      el.appendChild(sep);
      continue;
    }
    rowItems.push(item);
    const row = document.createElement("div");
    row.className = "ctx-menu-item";
    if (item.disabled) row.classList.add("disabled");
    if (item.danger) row.classList.add("danger");
    row.setAttribute("role", "menuitem");
    if (item.icon) {
      const icon = document.createElement("span");
      icon.className = "ctx-menu-icon";
      icon.textContent = item.icon;
      row.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "ctx-menu-label";
    label.textContent = item.label ?? "";
    row.appendChild(label);
    if (item.shortcut) {
      const kbd = document.createElement("kbd");
      kbd.className = "ctx-menu-shortcut";
      kbd.textContent = item.shortcut;
      row.appendChild(kbd);
    }
    if (item.submenu?.length) {
      const arrow = document.createElement("span");
      arrow.className = "ctx-menu-arrow";
      arrow.textContent = "›";
      row.appendChild(arrow);
    }
    el.appendChild(row);
  }
  return { el, items: rowItems };
}

/** Position a (freshly measured) menu at viewport coordinates, clamped. */
function placeMenu(el: HTMLElement, x: number, y: number): void {
  el.style.left = "0px";
  el.style.top = "0px";
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const clamp = (v: number, max: number) =>
    Math.max(EDGE_MARGIN, Math.min(v, max - EDGE_MARGIN));
  el.style.left = `${clamp(x, window.innerWidth - w)}px`;
  el.style.top = `${clamp(y, window.innerHeight - h)}px`;
}

function setActive(level: MenuLevel, index: number): void {
  level.activeIndex = index;
  level.el
    .querySelectorAll<HTMLElement>(".ctx-menu-item")
    .forEach((row, i) => row.classList.toggle("active", i === index));
}

/** Remove any submenu opened from `level` (and its descendants). */
function closeChild(level: MenuLevel): void {
  const i = stack.indexOf(level);
  if (i < 0) return;
  while (stack.length > i + 1) {
    const top = stack.pop()!;
    top.el.remove();
  }
  level.openChildIndex = undefined;
}

function openSubmenuAt(level: MenuLevel, index: number): void {
  const item = level.items[index];
  if (!item?.submenu?.length || item.disabled) return;
  clearHoverTimers();
  closeChild(level);
  const { el: child, items: childItems } = buildMenu(item.submenu);
  ensureRoot().appendChild(child);

  const rows = level.el.querySelectorAll<HTMLElement>(".ctx-menu-item");
  const pr = rows[index].getBoundingClientRect();
  child.style.left = "0px";
  child.style.top = "0px";
  const w = child.offsetWidth;
  const h = child.offsetHeight;
  // Default: open to the right of the parent row; flip left on overflow.
  let x = pr.right - 2;
  if (x + w > window.innerWidth - EDGE_MARGIN && pr.left - w - EDGE_MARGIN >= 0) {
    x = pr.left - w + 2;
  } else {
    x = Math.max(EDGE_MARGIN, Math.min(x, window.innerWidth - w - EDGE_MARGIN));
  }
  const y = Math.max(EDGE_MARGIN, Math.min(pr.top - 2, window.innerHeight - h - EDGE_MARGIN));
  child.style.left = `${x}px`;
  child.style.top = `${y}px`;

  level.openChildIndex = index;
  const childLevel: MenuLevel = { el: child, items: childItems, activeIndex: -1 };
  stack.push(childLevel);
  wireMenu(childLevel);
  // Moving the pointer into the submenu cancels the parent's pending close.
  child.addEventListener("mouseenter", clearHoverTimers);
}

function wireMenu(level: MenuLevel): void {
  level.el.querySelectorAll<HTMLElement>(".ctx-menu-item").forEach((row, index) => {
    const item = level.items[index];
    if (item.disabled) return;

    row.addEventListener("mouseenter", () => {
      clearHoverTimers();
      setActive(level, index);
      if (item.submenu?.length) {
        // (Re)open this row's submenu unless it is already open.
        if (level.openChildIndex !== index) {
          openTimer = setTimeout(() => openSubmenuAt(level, index), OPEN_DELAY_MS);
        }
      } else if (level.openChildIndex !== undefined) {
        // Moving onto a leaf row closes any submenu a sibling left open.
        closeChild(level);
      }
    });
    row.addEventListener("mouseleave", () => {
      if (openTimer !== undefined) {
        clearTimeout(openTimer);
        openTimer = undefined;
      }
      // Close this row's submenu shortly, unless the pointer reaches it in
      // time (the submenu's mouseenter cancels the timer).
      if (level.openChildIndex === index) {
        closeTimer = setTimeout(() => closeChild(level), CLOSE_DELAY_MS);
      }
    });
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      if (item.submenu?.length) {
        openSubmenuAt(level, index);
        return;
      }
      closeMenu();
      item.run?.();
    });
  });
}

function closeSubmenu(): void {
  const top = stack.pop();
  if (!top) return;
  top.el.remove();
  const parent = stack[stack.length - 1];
  if (parent) parent.openChildIndex = undefined;
}

/** Teardown: clear timers/state and hide the menu DOM. */
function closeMenu(): void {
  if (!open) return;
  open = false;
  clearHoverTimers();
  for (const level of stack) level.el.remove();
  stack = [];
}

function onKeydown(e: KeyboardEvent): void {
  if (!open) return;
  const top = stack[stack.length - 1];
  if (!top) return;

  const down = e.key === "ArrowDown" || e.key === "Tab";
  const up = e.key === "ArrowUp";
  if (down || up) {
    e.preventDefault();
    e.stopPropagation();
    if (top.items.length === 0) return;
    const delta = down ? 1 : -1;
    let next = top.activeIndex + delta;
    for (let i = 0; i < top.items.length; i++) {
      const idx = ((next % top.items.length) + top.items.length) % top.items.length;
      if (!top.items[idx].disabled) {
        setActive(top, idx);
        return;
      }
      next += delta;
    }
    return;
  }

  if (e.key === "ArrowRight" || e.key === "Enter") {
    const item = top.items[top.activeIndex];
    if (!item) return;
    e.preventDefault();
    e.stopPropagation();
    if (item.submenu?.length) openSubmenuAt(top, top.activeIndex);
    else {
      closeMenu();
      item.run?.();
    }
    return;
  }

  if (e.key === "ArrowLeft" || e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    if (stack.length > 1) closeSubmenu();
    else closeMenu();
    return;
  }

  // Any other key dismisses the menu; the keystroke itself falls through to
  // whatever has focus (the terminal, for a pane menu).
  closeMenu();
}

function onMouseDown(e: MouseEvent): void {
  if (!open) return;
  if (root && e.target instanceof Node && root.contains(e.target)) return;
  closeMenu();
}

function onContextMenu(e: MouseEvent): void {
  if (!open) return;
  if (root && e.target instanceof Node && root.contains(e.target)) return;
  closeMenu();
}

/** Show a context menu at viewport coordinates (typically a right-click). */
export function showContextMenu(items: ContextMenuItem[], x: number, y: number): void {
  closeMenu();
  const { el, items: rowItems } = buildMenu(items);
  const first: MenuLevel = { el, items: rowItems, activeIndex: -1 };
  ensureRoot().appendChild(el);
  placeMenu(el, x, y);
  stack = [first];
  wireMenu(first);
  open = true;
}

export function closeContextMenu(): void {
  closeMenu();
}

/** Whether a context menu is currently open (guards global shortcuts). */
export function isContextMenuOpen(): boolean {
  return open;
}

// Global dismissal listeners (all guarded by the `open` flag).
window.addEventListener("mousedown", onMouseDown, true);
window.addEventListener("contextmenu", onContextMenu, true);
window.addEventListener("blur", closeMenu);
window.addEventListener("resize", closeMenu);
window.addEventListener("keydown", onKeydown, true);
