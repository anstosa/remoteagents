import { createContext, isValidElement, type KeyboardEvent, type ReactElement, type ReactNode, type RefObject, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { FlyoutPortal } from './flyout-portal.js';
import { useViewportFlyout } from './viewport-flyout.js';

// The app-wide phone breakpoint. A phone shows a Workspace's panels one per screen, in a swipe
// carousel, and expanding a panel there hides the tab row and toolbar instead.
const phoneQuery = '(max-width: 768px)';
// Below this panel width a header's secondary actions fold into its ⋮.
const panelFoldWidth = 620;
// the header's shared glyphs, for panels to reuse in their own actions
export const panelIcons = { expand: 'M9 3H3v6m18 6v6h-6M3 3l6 6m6 6 6 6', restore: 'M9 3v6H3m18 6h-6v6M3 9l6-6m6 18 6-6', close: 'm6 6 12 12M18 6 6 18', copy: 'M9 9h10v10H9zM5 15H4V5h10v1', check: 'm5 12 4 4L19 6' };

const matchesPhone = () => typeof window !== 'undefined' && window.matchMedia(phoneQuery).matches;
const subscribePhone = (listener: () => void) => {
  const media = window.matchMedia(phoneQuery);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
};
// Whether the phone layout applies now.
export const usePhoneLayout = (): boolean => useSyncExternalStore(subscribePhone, matchesPhone, () => false);

// Which panel of a Workspace fills it, by split key ('agent', 'note', 'browser', 'code', or a
// Terminal's pane id). One key at most; the split hides every sibling of the expanded panel. On a
// phone the expansion is `immersive` instead: whichever panel is in view fills the screen, and the
// tab row and toolbar fold away.
export type PanelExpansion = {
  expanded: string | undefined;
  immersive: boolean;
  setExpanded: (key: string, on: boolean) => void;
  toggle: (key: string) => void;
  restore: () => void;
};

// Hold one Workspace's expansion. It is transient (a panel that wants its expansion back after a
// reload, like the note, restores it itself through setExpanded, which a phone ignores), and
// crossing the phone breakpoint either way restores.
export function usePanelExpansion(): PanelExpansion {
  const [expanded, setExpandedKey] = useState<string>();
  const [immersive, setImmersive] = useState(false);
  const phone = useRef(matchesPhone());
  useLayoutEffect(() => {
    const media = window.matchMedia(phoneQuery);
    const sync = () => {
      phone.current = media.matches;
      setExpandedKey(undefined);
      setImmersive(false);
    };
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);
  const setExpanded = useCallback((key: string, on: boolean) => {
    if (on) { if (!phone.current) setExpandedKey(key); }
    else setExpandedKey(current => current === key ? undefined : current);
  }, []);
  const toggle = useCallback((key: string) => {
    if (phone.current) setImmersive(current => !current);
    else setExpandedKey(current => current === key ? undefined : key);
  }, []);
  const restore = useCallback(() => {
    setExpandedKey(undefined);
    setImmersive(false);
  }, []);
  return { expanded, immersive, setExpanded, toggle, restore };
}

// What the split hands its panels: the expanded key (only while that panel is open) and the
// controls. Panels read it by their own key through usePanelExpand.
export const PanelExpandContext = createContext<Omit<PanelExpansion, 'setExpanded' | 'immersive'> | undefined>(undefined);

// Scope an expansion to the panels a container holds (`openKeys`, in any order). The expanded key
// counts only while its panel is open: a panel that has not mounted yet (a note still loading)
// keeps its request without hiding its siblings, and closing the expanded panel restores the
// rest, so reopening it does not expand it again. While immersive (a phone), the expanded panel is
// the one in view (`visibleKey`), so it follows a swipe, and closing that panel restores. `onKeyDown`
// goes on the container: Esc restores, except inside a pane's canvas (a shell app needs its Escape)
// or the agent panel's composer, after a handler that already used the key, or from a flyout
// portaled out of the container.
export function useExpansionScope(expansion: PanelExpansion, openKeys: readonly string[], containerRef: RefObject<HTMLElement | null>, visibleKey?: string) {
  const { expanded: requested, immersive, toggle, restore } = expansion;
  const expanded = immersive
    ? visibleKey !== undefined && openKeys.includes(visibleKey) ? visibleKey : undefined
    : requested !== undefined && openKeys.includes(requested) ? requested : undefined;
  const signature = openKeys.join('|');
  const previousKeys = useRef(openKeys);
  const request = useRef({ requested, immersive });
  request.current = { requested, immersive };
  // the panel in view at the last commit, which a close may just have taken away
  const shown = useRef(visibleKey);
  useLayoutEffect(() => {
    const previous = previousKeys.current;
    previousKeys.current = signature.split('|');
    const closed = previous.filter(key => !previousKeys.current.includes(key));
    // full screen ends with the panel it was showing, not with a shell exiting off screen
    const { requested: key, immersive: full } = request.current;
    const ended = full ? shown.current : key;
    if (ended !== undefined && closed.includes(ended)) restore();
  }, [signature, restore]);
  useLayoutEffect(() => { shown.current = visibleKey; });
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || expanded === undefined || event.defaultPrevented) return;
    const target = event.target as Element;
    if (!containerRef.current?.contains(target) || target.closest('.log-canvas, .terminal-canvas, .prompt') !== null) return;
    event.preventDefault();
    restore();
  };
  const context = useMemo(() => ({ expanded, toggle, restore }), [expanded, toggle, restore]);
  return { expanded, context, onKeyDown };
}

// One panel's view of the shared expansion; undefined outside a split.
export function usePanelExpand(key: string) {
  const context = useContext(PanelExpandContext);
  if (context === undefined) return undefined;
  return { expanded: context.expanded === key, anyExpanded: context.expanded !== undefined, toggle: () => context.toggle(key), restore: context.restore };
}

// One header action. Inline it is an icon button labelled by `label`; folded into the ⋮ it is a
// row showing the icon and the label.
export type PanelAction = {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  title?: string;
  className?: string;
  disabled?: boolean;
  pressed?: boolean;
  // aria-expanded, for an action that opens a popup of its own
  popupOpen?: boolean;
};

const actionButton = (action: PanelAction, row = false) => <button key={action.key} type="button" className={`panel-header-action${row ? ' panel-header-row' : ''}${action.className === undefined ? '' : ` ${action.className}`}`} disabled={action.disabled} aria-label={action.label} aria-pressed={action.pressed} aria-expanded={action.popupOpen} title={action.title ?? action.label} onClick={action.onSelect}>{action.icon}{row && <span>{action.label}</span>}</button>;

export function PanelIcon({ path }: { path: string }) {
  return <svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><path d={path} /></svg>;
}

type PanelHeaderProps = {
  // the panel's split key, which the expand control promotes
  panelKey: string;
  // names the panel in the expand control's label ("Expand note", "Restore terminal build")
  label: string;
  // the left pill: the panel's title, picker or address field
  title: ReactNode;
  // always-visible actions, before the secondary ones
  actions?: ReactNode;
  // actions that fold into the ⋮ when the panel is narrow
  secondary?: PanelAction[];
  // the trailing action: close, minimize for a Terminal, or a control that opens a popup of its
  // own (the agent panel's power menu)
  close?: PanelAction | ReactElement;
  expandDisabled?: boolean;
};

// The floating header every panel shares: a title pill top-left and an action pill top-right,
// over the panel's content. No bar sits behind them. The action pill ends with expand (which
// fills the Workspace with this panel) and the panel's close.
export function PanelHeader({ panelKey, label, title, actions, secondary = [], close, expandDisabled = false }: PanelHeaderProps) {
  const expand = usePanelExpand(panelKey);
  const phone = usePhoneLayout();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLButtonElement>(moreOpen);
  // fold by the panel's own width, so a squeezed split column folds as a phone does
  useLayoutEffect(() => {
    const panel = wrapRef.current?.parentElement;
    if (panel === null || panel === undefined) return;
    const measure = () => {
      const width = panel.getBoundingClientRect().width;
      // a hidden panel measures zero; keep its last layout
      if (width > 0) setFolded(width < panelFoldWidth);
    };
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    measure();
    return () => observer.disconnect();
  }, []);
  useEffect(() => { if (!folded) setMoreOpen(false); }, [folded]);
  const closeMore = useCallback(() => setMoreOpen(false), []);
  const showMore = folded && secondary.length > 0;
  return <div ref={wrapRef} className="panel-header">
    <div className="panel-header-pill panel-header-title">{title}</div>
    <div className="panel-header-pill panel-header-actions" role="toolbar" aria-label={`${label[0].toUpperCase()}${label.slice(1)} actions`}>
      {actions}
      {!folded && secondary.map(action => actionButton(action))}
      {showMore && <button ref={anchorRef} type="button" className={`panel-header-action panel-header-more${moreOpen ? ' active' : ''}`} aria-label={`More ${label} actions`} aria-expanded={moreOpen} title="More" onClick={() => setMoreOpen(value => !value)} onKeyDown={event => { if (event.key === 'Escape' && moreOpen) { event.preventDefault(); event.stopPropagation(); closeMore(); } }}><svg className="panel-header-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></svg></button>}
      {expand !== undefined && <button type="button" className="panel-header-action panel-header-expand" disabled={expandDisabled} aria-label={`${expand.expanded ? 'Restore' : 'Expand'} ${label}`} aria-pressed={expand.expanded} title={phone ? expand.expanded ? 'Show the tabs and toolbar' : 'Full screen' : expand.expanded ? 'Restore the other panels' : 'Fill the Workspace'} onClick={expand.toggle}><PanelIcon path={expand.expanded ? panelIcons.restore : panelIcons.expand} /></button>}
      {close === undefined || isValidElement(close) ? close : actionButton(close)}
    </div>
    {showMore && moreOpen && <FlyoutPortal onDismiss={closeMore}><div ref={flyoutRef} className="more-menu panel-header-menu" role="group" aria-label={`More ${label} actions`} style={style} onClick={closeMore} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); closeMore(); } }}>{secondary.map(action => actionButton(action, true))}</div></FlyoutPortal>}
  </div>;
}
