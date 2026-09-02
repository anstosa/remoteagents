import { codexAdapter } from './codex.js';
import { omxAdapter } from './omx.js';
import { claudeAdapter } from './claude.js';
import type { Pane } from '../domain/models.js';
import type { Adapter, AdapterCapability, AdapterConfigs, AgentKind } from './types.js';

/**
 * The closed registry. It is code, not plugins: adding a kind means adding an
 * Adapter here. Codex, OMX and Claude are registered; Pi and OpenCode arrive in
 * later chunks. Order is the resolution/priority order (`codex`, `omx`, `claude`,
 * `pi`, `opencode`) and the order cleanup rules are tried in. It plays no part in
 * telling OMX from Codex: the walker meets the OMX wrapper above the Codex child
 * in the pane's tree, and neither recognizer matches the other's process (ADR 0005).
 *
 * The process walker (`discovery/processes.ts`) imports this module, and this
 * module imports every Adapter, so an Adapter must never import the walker for
 * a value (types are fine): the Codex and OMX Adapters both hold the `codex-tui.ts`
 * objects at load time, which only works while the graph stays acyclic.
 */
export const adapters: readonly Adapter[] = [codexAdapter, omxAdapter, claudeAdapter];

export function adapterFor(kind: AgentKind): Adapter | undefined {
  return adapters.find((adapter) => adapter.kind === kind);
}

/** The first registered Adapter that recognises the process, by registry order. */
export function recognizeProcess(process: { comm: string; argv: string[] }): Adapter | undefined {
  return adapters.find((adapter) => adapter.recognizes(process));
}

/** Whether any Adapter excludes this pane from the dashboard (e.g. OMX worker panes). */
export function paneExcluded(pane: Pane): boolean {
  return adapters.some((adapter) => adapter.panes?.exclude?.(pane) ?? false);
}

/**
 * The capability record the Dashboard publishes per registered kind (ADR 0002).
 * Every capability but launchability is intrinsic to the Adapter. Launchability is
 * config-gated: with an `adapters` block a kind is launchable only when its program
 * is configured and executable (`unavailableReason`/`program` carry the details).
 * The legacy configuration (no `adapters` block at all) keeps Codex launchable
 * through its per-worktree `command`, exactly as chunk 1 did.
 */
export function adapterCapabilities(configs?: AdapterConfigs): Partial<Record<AgentKind, AdapterCapability>> {
  const legacy = configs === undefined;
  return Object.fromEntries(adapters.map((adapter) => {
    const configured = configs?.[adapter.kind];
    return [adapter.kind, {
      launchable: legacy ? true : (configured?.launchable ?? false),
      ...(configured?.unavailableReason === undefined ? {} : { unavailableReason: configured.unavailableReason }),
      ...(configured?.program === undefined ? {} : { program: configured.program }),
      stateSource: adapter.stateSource,
      turnCapture: adapter.turns !== undefined,
      bookmarks: adapter.conversations !== undefined,
      inlineQuestions: adapter.questions !== undefined,
      commands: adapter.commands !== undefined,
      sandbox: adapter.sandbox !== undefined,
    }];
  }));
}
