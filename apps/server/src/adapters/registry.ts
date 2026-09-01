import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';
import type { Pane } from '../domain/models.js';
import type { Adapter, AdapterCapability, AdapterConfigs, AgentKind } from './types.js';

/**
 * The closed registry. It is code, not plugins: adding a kind means adding an
 * Adapter here. Chunk 2 registers Codex and Claude; Pi and OpenCode arrive in
 * later chunks. Order is the resolution/priority order (`codex`, `claude`, `pi`,
 * `opencode`).
 *
 * This module sits in an import cycle (processes.ts ↔ registry ↔ codex.ts), which
 * is safe only because every cross-module reference is used at call time, never
 * at load time. Keep it that way: do not invoke `recognizeProcess`,
 * `adapterCapabilities`, or an adapter method at module scope.
 */
export const adapters: readonly Adapter[] = [codexAdapter, claudeAdapter];

export function adapterFor(kind: AgentKind): Adapter | undefined {
  return adapters.find((adapter) => adapter.kind === kind);
}

/** The first registered Adapter that recognises the process, by registry order. */
export function recognizeProcess(process: { comm: string; argv: string[] }): Adapter | undefined {
  return adapters.find((adapter) => adapter.recognizes(process));
}

/** Whether any Adapter excludes this pane from the dashboard (e.g. OMX worker panes). */
export function paneExcluded(pane: Pane): boolean {
  return adapters.some((adapter) => adapter.panes?.exclude(pane) ?? false);
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
