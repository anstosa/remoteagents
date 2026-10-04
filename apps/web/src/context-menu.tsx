import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type ReactPortal } from 'react';
import { createPortal } from 'react-dom';
import './context-menu.css';

export type ContextMenuItem = {
  type: 'action';
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  mode?: 'checkbox' | 'radio';
  checked?: boolean;
  onSelect: () => void | Promise<void>;
} | {
  type: 'separator';
  id?: string;
};

type ContextMenuConfig = {
  label: string;
  items: ContextMenuItem[] | (() => ContextMenuItem[]);
};

type ContextMenuHandle = {
  update: () => void;
  close: () => void;
};

type ContextMenuState = {
  id: number;
  config: ContextMenuConfig;
  x: number;
  y: number;
  keyboard: boolean;
  origin: HTMLElement | null;
};

type ContextMenuLayout = {
  menuId: number;
  style: CSSProperties;
};

let activeMenu: ContextMenuState | undefined;
let menuId = 0;
let revision = 0;
const listeners = new Set<() => void>();

// keep a source's interaction mode while its menu temporarily owns focus
export function contextMenuOwnsFocus(source: Element): boolean {
  const origin = activeMenu?.origin;
  return origin !== undefined && origin !== null && source.contains(origin);
}

// notify the mounted host about menu changes
function notifyContextMenuHost() {
  revision += 1;
  // update every mounted subscriber
  for (const listener of listeners) listener();
}

// subscribe one host to the external menu state
function subscribeContextMenuHost(listener: () => void) {
  listeners.add(listener);
  // remove the unmounted host
  return () => listeners.delete(listener);
}

// expose the current external-store revision
function contextMenuRevision() {
  return revision;
}

// close only the menu represented by one handle
function closeContextMenu(menu: number) {
  // leave a newer menu intact
  if (activeMenu?.id !== menu) return;
  activeMenu = undefined;
  notifyContextMenuHost();
}

// recognize keyboard invocation even when the browser supplies anchor coordinates
function contextMenuPoint(event: globalThis.MouseEvent | ReactMouseEvent) {
  const keyboard = event.button === -1 || event.clientX === 0 && event.clientY === 0;
  const source = event.currentTarget instanceof Element ? event.currentTarget : event.target instanceof Element ? event.target : undefined;
  // place a keyboard-opened menu below its invocation target
  if (keyboard && source !== undefined) {
    const bounds = source.getBoundingClientRect();
    return { keyboard, x: bounds.left, y: bounds.bottom };
  }
  return { keyboard, x: event.clientX, y: event.clientY };
}

// open or replace the shared contextual menu
export function openContextMenu(event: globalThis.MouseEvent | ReactMouseEvent, config: ContextMenuConfig): ContextMenuHandle {
  event.preventDefault();
  event.stopPropagation();
  const point = contextMenuPoint(event);
  const id = ++menuId;
  activeMenu = {
    id,
    config,
    ...point,
    origin: document.activeElement instanceof HTMLElement ? document.activeElement : null
  };
  notifyContextMenuHost();
  return {
    // re-read a dynamic item provider
    update: () => {
      // ignore updates from replaced menus
      if (activeMenu?.id === id) notifyContextMenuHost();
    },
    // close only this menu instance
    close: () => closeContextMenu(id)
  };
}

// find the first enabled action for roving focus
function firstEnabledItem(items: ContextMenuItem[]) {
  return items.find(item => item.type === 'action' && !item.disabled);
}

// resolve the checked-item aria role
function contextMenuItemRole(item: Extract<ContextMenuItem, { type: 'action' }>) {
  // expose checkbox state to assistive technology
  if (item.mode === 'checkbox') return 'menuitemcheckbox' as const;
  // expose radio state to assistive technology
  if (item.mode === 'radio') return 'menuitemradio' as const;
  return 'menuitem' as const;
}

// constrain one coordinate to the visible viewport
function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

// log failed asynchronous menu actions without masking them
function reportContextMenuError(label: string, error: unknown) {
  console.error(`Context menu action failed: ${label}`, error);
}

// invoke one action and surface synchronous or asynchronous failure
function invokeContextMenuAction(item: Extract<ContextMenuItem, { type: 'action' }>) {
  try {
    const result = item.onSelect();
    // report rejected asynchronous actions
    if (result !== undefined) void Promise.resolve(result).catch(error => reportContextMenuError(item.label, error));
  } catch (error) {
    reportContextMenuError(item.label, error);
  }
}

// render the single shared contextual menu portal
export function ContextMenuHost(): ReactPortal | null {
  const storeRevision = useSyncExternalStore(subscribeContextMenuHost, contextMenuRevision, contextMenuRevision);
  const menu = activeMenu;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const preparedMenuId = useRef<number | undefined>(undefined);
  const [activeId, setActiveId] = useState<string>();
  const [layout, setLayout] = useState<ContextMenuLayout>();
  const items = menu === undefined ? [] : typeof menu.config.items === 'function' ? menu.config.items() : menu.config.items;
  const firstEnabled = firstEnabledItem(items);
  const selected = items.find(item => item.type === 'action' && item.id === activeId && !item.disabled);
  const effectiveActiveId = selected?.type === 'action' ? selected.id : firstEnabled?.type === 'action' ? firstEnabled.id : undefined;

  // restore displaced focus before an action or outside gesture chooses its destination
  const dismiss = () => {
    // ignore an already closed menu
    if (menu === undefined) return;
    const shouldRestore = menuRef.current?.contains(document.activeElement) === true && menu.origin?.isConnected === true;
    closeContextMenu(menu.id);
    // subsequent focus changes must produce a real blur on the source
    if (shouldRestore) menu.origin?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    // clear retained item nodes for a closed menu
    if (menu === undefined) {
      itemRefs.current.clear();
      return;
    }
    const element = menuRef.current;
    // wait until the portal node is mounted
    if (element === null) return;
    const opening = preparedMenuId.current !== menu.id;
    // initialize a newly opened menu without focusing mouse invocations
    if (opening) {
      preparedMenuId.current = menu.id;
      setActiveId(firstEnabled?.type === 'action' ? firstEnabled.id : undefined);
    }
    const position = () => {
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const margin = 8;
      const availableWidth = Math.max(1, viewportWidth - margin * 2);
      const availableHeight = Math.max(1, viewportHeight - margin * 2);
      const width = Math.min(element.offsetWidth, availableWidth);
      const height = Math.min(element.offsetHeight, availableHeight);
      const left = clamp(menu.x, viewportLeft + margin, viewportLeft + viewportWidth - width - margin);
      const top = clamp(menu.y, viewportTop + margin, viewportTop + viewportHeight - height - margin);
      setLayout({ menuId: menu.id, style: { position: 'fixed', left, top, maxWidth: availableWidth, maxHeight: availableHeight, visibility: 'visible' } });
    };
    position();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(position);
    observer?.observe(element);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    // focus keyboard invocations after the positioned portal becomes visible
    if (menu.keyboard && opening) requestAnimationFrame(() => {
      // leave replaced menus and detached hosts alone
      if (activeMenu?.id !== menu.id || !element.isConnected) return;
      const target = firstEnabled?.type === 'action' ? itemRefs.current.get(firstEnabled.id) : element;
      target?.focus({ preventScroll: true });
    });
    // stop observing the closed or replaced menu
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [menu?.id, storeRevision]);

  useEffect(() => {
    // skip document handlers while no menu is open
    if (menu === undefined) return;
    const select = (item: Extract<ContextMenuItem, { type: 'action' }>) => {
      // ignore stale or unavailable actions
      if (item.disabled || activeMenu?.id !== menu.id) return;
      dismiss();
      invokeContextMenuAction(item);
    };
    const focusItem = (item: Extract<ContextMenuItem, { type: 'action' }>) => {
      setActiveId(item.id);
      // mouse-open menus retain the editor and its interaction mode
      if (menu.keyboard) itemRefs.current.get(item.id)?.focus({ preventScroll: true });
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      // close without changing a mouse-open menu's retained focus
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      // let normal tab navigation choose its next target
      if (event.key === 'Tab') {
        dismiss();
        return;
      }
      // dismiss before passing browser shortcuts or modified input to the source
      if (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/u.test(event.key)) {
        dismiss();
        return;
      }
      // prevent typing from changing a captured selection or reaching the terminal
      event.preventDefault();
      event.stopPropagation();
      const enabled = items.filter((item): item is Extract<ContextMenuItem, { type: 'action' }> => item.type === 'action' && !item.disabled);
      const current = enabled.findIndex(item => item.id === effectiveActiveId);
      let next: Extract<ContextMenuItem, { type: 'action' }> | undefined;
      // move to the next available item
      if (event.key === 'ArrowDown') next = enabled[(current + 1 + enabled.length) % enabled.length];
      // move to the previous available item
      else if (event.key === 'ArrowUp') next = enabled[(current - 1 + enabled.length) % enabled.length];
      // jump to the first available item
      else if (event.key === 'Home') next = enabled[0];
      // jump to the last available item
      else if (event.key === 'End') next = enabled.at(-1);
      // activate the current item
      else if (event.key === 'Enter' || event.key === ' ') {
        const item = enabled.find(candidate => candidate.id === effectiveActiveId);
        // activate only an available item
        if (item !== undefined) select(item);
        return;
      } else return;
      // leave an empty menu focused at its container
      if (next === undefined && menu.keyboard) menuRef.current?.focus({ preventScroll: true });
      else if (next !== undefined) focusItem(next);
    };
    const dismissOutside = (event: Event) => {
      // allow the outside interaction to choose focus normally
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) dismiss();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('contextmenu', dismissOutside, true);
    // remove handlers from the closed or refreshed menu
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('contextmenu', dismissOutside, true);
    };
  }, [effectiveActiveId, items, menu, storeRevision]);

  // omit the portal while closed or outside a browser
  if (menu === undefined || typeof document === 'undefined') return null;
  const style = layout?.menuId === menu.id ? layout.style : {
    position: 'fixed',
    left: menu.x,
    top: menu.y,
    maxWidth: 'calc(100vw - 1rem)',
    maxHeight: 'calc(100dvh - 1rem)',
    visibility: 'hidden'
  } satisfies CSSProperties;
  return createPortal(
    <div
      ref={menuRef}
      className="context-menu"
      role="menu"
      aria-label={menu.config.label}
      tabIndex={-1}
      style={style}
      onContextMenu={event => { /* suppress the native menu over custom items */ event.preventDefault(); }}
    >
      {items.map((item, index) => {
        // render semantic separators between action groups
        if (item.type === 'separator') return <div className="context-menu-separator" key={item.id ?? `separator-${index}`} role="separator" />;
        const role = contextMenuItemRole(item);
        return <button
          key={item.id}
          ref={element => {
            // retain current item nodes for roving focus
            if (element === null) itemRefs.current.delete(item.id);
            else itemRefs.current.set(item.id, element);
          }}
          className="context-menu-item"
          type="button"
          role={role}
          aria-checked={role === 'menuitem' ? undefined : item.checked === true}
          aria-disabled={item.disabled || undefined}
          disabled={item.disabled}
          tabIndex={-1}
          data-active={item.id === effectiveActiveId || undefined}
          onPointerEnter={() => { /* track hover without stealing the source selection */ setActiveId(item.id); }}
          onPointerDown={event => { /* retain textarea and document selections */ event.preventDefault(); }}
          onMouseDown={event => { /* cover browsers without pointer events */ event.preventDefault(); }}
          onClick={event => {
            // contain the selected menu action
            event.stopPropagation();
            // resolve the current item through the active provider
            const currentItems = typeof menu.config.items === 'function' ? menu.config.items() : menu.config.items;
            const currentItem = currentItems.find(candidate => candidate.type === 'action' && candidate.id === item.id);
            // run only a still-available action
            if (currentItem?.type === 'action' && !currentItem.disabled) {
              dismiss();
              invokeContextMenuAction(currentItem);
            }
          }}
        >
          {/* allow action glyphs while retaining checked-state semantics */}
          <span className="context-menu-mark" aria-hidden="true">{item.icon ?? (item.mode === 'checkbox' ? item.checked ? '✓' : '' : item.mode === 'radio' ? item.checked ? '●' : '' : '')}</span>
          <span className="context-menu-label">{item.label}</span>
        </button>;
      })}
    </div>,
    document.body
  );
}
