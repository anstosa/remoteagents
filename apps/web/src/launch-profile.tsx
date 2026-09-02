import { createPortal } from 'react-dom';
import { createContext, useContext, useEffect, useState } from 'react';
import { useViewportFlyout } from './viewport-flyout.js';

// The closed registry of agent kinds, in resolution/priority order (duplicated from the
// server's `agentKinds` by design). A configured kind (one with a program) is launchable;
// recognition of a kind needs no configuration.
export type AgentKind = 'codex' | 'omx' | 'claude' | 'pi' | 'opencode';
export const agentKinds: readonly AgentKind[] = ['codex', 'omx', 'claude', 'pi', 'opencode'];
// per-kind badge glyph and display label, shared by the split button, tab badge and AGENTS card
export const agentKindGlyph: Record<AgentKind, string> = { codex: '◆', omx: '◈', claude: '✳', pi: 'π', opencode: '◇' };
export const agentKindLabel: Record<AgentKind, string> = { codex: 'Codex', omx: 'OMX', claude: 'Claude', pi: 'Pi', opencode: 'OpenCode' };

// The capability record the Dashboard publishes per registered kind (ADR 0002). The web
// reads presence and reasons; it never re-derives capabilities. `sandbox*` stay undefined
// until chunk 4 arms the sandbox, so every launch is unsandboxed here.
export type AdapterCapability = { launchable: boolean; unavailableReason?: string; program?: string; stateSource: 'reported' | 'title' | 'both'; turnCapture: boolean; bookmarks: boolean; inlineQuestions: boolean; commands: boolean; sandbox: boolean; sandboxUnavailableReason?: string };
export type AdapterCapabilities = Partial<Record<AgentKind, AdapterCapability>>;

export type LaunchScope = 'worktree' | 'project' | 'scratch';
export type LaunchOrigin = LaunchScope | 'default';
// The Launch profile resolution the server publishes so the web renders the menu without
// re-deriving it: which kind a one-click Launch uses, why, and any remembered kind skipped.
export type LaunchResolution = { kind?: AgentKind; origin?: LaunchOrigin; skipped?: { kind: AgentKind; origin: LaunchScope; reason: string } };
// what a launch/restart row sends to a launch-family route; sandboxed is never remembered
export type LaunchChoice = { kind: AgentKind; sandboxed: boolean };

// the per-kind adapter capabilities from the active dashboard, for the Launch controls
export const AdaptersContext = createContext<AdapterCapabilities | undefined>(undefined);

// the configured kinds (those with a program), in registry order
export const configuredKinds = (adapters: AdapterCapabilities | undefined): AgentKind[] => agentKinds.filter(kind => adapters?.[kind]?.program !== undefined);
// a launch of this kind starts Sandboxed by default whenever the console can enforce it
export const defaultSandboxed = (capability: AdapterCapability | undefined): boolean => capability?.sandbox === true && capability.sandboxUnavailableReason === undefined;

// POST body for a launch-family route: the chosen kind and whether to confine it
export const launchRequestInit = (choice: LaunchChoice): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(choice) });

// sandbox line per kind and state — copy from the effort's Launch profile section
export const sandboxCopy = (kind: AgentKind, capability: AdapterCapability | undefined, sandboxed: boolean): string => {
  if (capability === undefined) return '';
  // Codex (and OMX, which runs Codex) names its own sandbox; other kinds say nothing until chunk 4 arms `sandbox`
  if (!capability.sandbox) return kind === 'codex' || kind === 'omx' ? "Uses Codex's own sandbox" : '';
  if (capability.sandboxUnavailableReason !== undefined) return kind === 'claude' ? `Sandbox as configured in Claude — ${capability.sandboxUnavailableReason}` : `Sandbox unavailable — ${capability.sandboxUnavailableReason}`;
  if (sandboxed) return kind === 'claude' ? 'Sandbox enforced by console' : 'Tool commands sandboxed by console';
  return kind === 'claude' ? 'Sandbox disabled for this launch' : 'Tool commands unsandboxed for this launch';
};
// why the resolved kind is resolved, shown against it in the menu
const originCopy = (origin: LaunchOrigin | undefined): string => origin === 'worktree' ? 'last used here' : origin === 'project' ? 'last used in this project' : origin === 'scratch' ? 'last used for scratch' : 'first configured';
const scopeCopy = (scope: LaunchScope): string => scope === 'worktree' ? 'here' : scope === 'project' ? 'this project' : 'scratch';

export type LaunchVerb = 'Launch' | 'Restart';
const actionCopy = (verb: LaunchVerb, kind: AgentKind | undefined): string => kind === undefined ? `${verb} agent` : verb === 'Launch' ? `Launch ${agentKindLabel[kind]}` : `Restart as ${agentKindLabel[kind]}`;

const KindMark = ({ kind }: { kind: AgentKind }) => <span className={`launch-kind-mark launch-kind-${kind}`} aria-hidden="true">{agentKindGlyph[kind]}</span>;
const LockIcon = () => <svg className="launch-lock" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>;
const UnlockIcon = () => <svg className="launch-lock open" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1.5" /><path d="M8 11V7a4 4 0 0 1 7.5-2.2" /></svg>;
const ChevronIcon = () => <svg className="launch-chevron-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;

// the disabled-primary hint, or undefined when a one-click launch is possible. A resolved
// kind (including the legacy config's Codex, which has no `program`) means launchable.
const launchHint = (adapters: AdapterCapabilities | undefined, resolution: LaunchResolution | undefined): string | undefined =>
  resolution?.kind !== undefined ? undefined
    : configuredKinds(adapters).length === 0 ? 'No agents configured — add an adapters entry to the console config.'
      : 'No configured agent is launchable right now';

// The menu of launch actions: one row per configured kind (the resolved one annotated
// with why), unavailable kinds disabled with their reason, then "without sandbox" rows for
// kinds that default to Sandboxed, and a footnote when a remembered kind was skipped.
export function LaunchMenu({ verb, label, resolution, onLaunch }: { verb: LaunchVerb; label: string; resolution: LaunchResolution | undefined; onLaunch: (choice: LaunchChoice) => void }) {
  const adapters = useContext(AdaptersContext);
  const kinds = configuredKinds(adapters);
  if (kinds.length === 0) return <p className="launch-menu-empty">No agents configured. Add an <code>adapters</code> entry to the console config to launch agents.</p>;
  const unsandboxable = kinds.filter(kind => adapters?.[kind]?.launchable === true && defaultSandboxed(adapters?.[kind]));
  const skipped = resolution?.skipped;
  return <>
    <p className="launch-menu-heading">{verb} · {label}</p>
    {kinds.map(kind => {
      const capability = adapters![kind]!;
      const sandboxed = defaultSandboxed(capability);
      const resolved = resolution?.kind === kind;
      return <button key={kind} type="button" role="menuitem" className="launch-row" disabled={!capability.launchable} title={capability.unavailableReason} onClick={() => onLaunch({ kind, sandboxed })}>
        <KindMark kind={kind} />
        <span className="launch-row-copy"><strong>{agentKindLabel[kind]}{resolved && <em> · {originCopy(resolution?.origin)}</em>}</strong><small>{capability.launchable ? sandboxCopy(kind, capability, sandboxed) : capability.unavailableReason ?? 'Unavailable'}</small></span>
        {capability.launchable && sandboxed && <LockIcon />}
      </button>;
    })}
    {unsandboxable.length > 0 && <><hr className="more-menu-divider" /><p className="launch-menu-heading launch-menu-subheading">Without sandbox — this launch only</p>{unsandboxable.map(kind => <button key={`${kind}-unsandboxed`} type="button" role="menuitem" className="launch-row launch-row-unsandboxed" onClick={() => onLaunch({ kind, sandboxed: false })}><KindMark kind={kind} /><span className="launch-row-copy"><strong>{agentKindLabel[kind]}</strong><small>{sandboxCopy(kind, adapters?.[kind], false)}</small></span><UnlockIcon /></button>)}</>}
    {skipped !== undefined && <p className="launch-menu-note">Remembered {agentKindLabel[skipped.kind]} ({scopeCopy(skipped.origin)}) skipped — {skipped.reason}</p>}
  </>;
}

// The split button: primary launches the resolved kind in one click (naming it, with a
// lock when Sandboxed); the chevron opens the actions menu. `compact`/`inline` give the
// launcher rows the same control with the menu expanded inline under the row. When the
// dashboard carries no resolution (`resolution === undefined`) the control degrades to a
// single plain "Launch agent" that launches without a kind, as before the split button.
export function LaunchSplitButton({ verb = 'Launch', label, resolution, onLaunch, disabled = false, pending = false, compact = false, inline = false }: { verb?: LaunchVerb; label: string; resolution: LaunchResolution | undefined; onLaunch: (choice?: LaunchChoice) => void; disabled?: boolean; pending?: boolean; compact?: boolean; inline?: boolean }) {
  const adapters = useContext(AdaptersContext);
  const [open, setOpen] = useState(false);
  const { anchorRef, flyoutRef, style } = useViewportFlyout<HTMLSpanElement>(open && !inline);
  useEffect(() => {
    if (!open || inline) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || flyoutRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, inline]);
  const primaryClass = compact ? 'launch-compact' : 'queue';
  const launch = (choice?: LaunchChoice) => { setOpen(false); onLaunch(choice); };
  // no resolution from the server: a plain, chevron-less launch of the default kind,
  // rendered exactly like the pre-split-button launch control
  if (resolution === undefined) {
    return <button type="button" className={primaryClass} disabled={disabled || pending} onClick={() => launch()}>{pending ? <span className="spinner" /> : null}{actionCopy(verb, undefined)}</button>;
  }
  const none = configuredKinds(adapters).length === 0;
  const resolvedKind = resolution.kind;
  const sandboxed = defaultSandboxed(resolvedKind === undefined ? undefined : adapters?.[resolvedKind]);
  const hint = launchHint(adapters, resolution);
  const menu = <LaunchMenu verb={verb} label={label} resolution={resolution} onLaunch={launch} />;
  const primaryTitle = hint ?? `${agentKindLabel[resolvedKind!]} — ${originCopy(resolution.origin)}${sandboxed ? ' — sandboxed' : ''}`;
  return <>
    {!compact && hint !== undefined && <small className="launch-hint">{hint}</small>}
    <span className={`launch-split${compact ? ' compact' : ''}`} role="group" aria-label={`${verb} agent`} ref={anchorRef}>
      <button type="button" className={`${primaryClass} launch-primary`} disabled={resolvedKind === undefined || disabled || pending} title={primaryTitle} onClick={() => resolvedKind !== undefined && launch({ kind: resolvedKind, sandboxed })}>
        {pending ? <span className="spinner" /> : resolvedKind !== undefined && <KindMark kind={resolvedKind} />}{actionCopy(verb, resolvedKind)}{sandboxed && <LockIcon />}
      </button>
      <button type="button" className={`launch-chevron${compact ? ' compact' : ''}`} aria-label="Choose agent" aria-haspopup="menu" aria-expanded={open} disabled={none || disabled || pending} onClick={() => setOpen(value => !value)}><ChevronIcon /></button>
    </span>
    {open && (inline
      ? <div className="launch-inline-menu more-menu" role="menu" aria-label="Choose agent">{menu}</div>
      : createPortal(<div ref={flyoutRef} style={style} className="more-menu flyout-menu launch-menu" role="menu" aria-label="Choose agent">{menu}</div>, document.body))}
  </>;
}

// the kind glyph in a tinted square plus a lock when Sandboxed, before an Agent tab's label
export function LaunchTabBadge({ kind, sandboxed }: { kind: AgentKind; sandboxed?: boolean }) {
  return <span className={`launch-tab-badge launch-kind-${kind}`} aria-hidden="true" title={`${agentKindLabel[kind]}${sandboxed ? ' · sandboxed' : ''}`}><KindMark kind={kind} />{sandboxed === true && <LockIcon />}</span>;
}
