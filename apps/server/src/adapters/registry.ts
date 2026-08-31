import { codexAdapter } from './codex.js';
import type { Adapter, AdapterCapability, AgentKind } from './types.js';

/**
 * The closed registry. It is code, not plugins: adding a kind means adding an
 * Adapter here. Chunk 1 registers only Codex; Claude, Pi and OpenCode arrive in
 * later chunks. Order is the resolution/priority order (`codex`, `claude`, `pi`,
 * `opencode`).
 *
 * This module sits in an import cycle (processes.ts ↔ registry ↔ codex.ts), which
 * is safe only because every cross-module reference is used at call time, never
 * at load time. Keep it that way: do not invoke `recognizeProcess`,
 * `adapterCapabilities`, or an adapter method at module scope.
 */
export const adapters: readonly Adapter[] = [codexAdapter];

export function adapterFor(kind: AgentKind): Adapter | undefined {
  return adapters.find((adapter) => adapter.kind === kind);
}

/** The first registered Adapter that recognises the process, by registry order. */
export function recognizeProcess(process: { comm: string; argv: string[] }): Adapter | undefined {
  return adapters.find((adapter) => adapter.recognizes(process));
}

/**
 * The capability record the Dashboard publishes per registered kind (ADR 0002).
 * Every capability but `launchable` is intrinsic to the Adapter; `launchable`
 * becomes config-gated in chunk 2, so for now a registered adapter is launchable
 * (Codex always is).
 */
export function adapterCapabilities(): Partial<Record<AgentKind, AdapterCapability>> {
  return Object.fromEntries(adapters.map((adapter) => [adapter.kind, {
    launchable: true,
    stateSource: adapter.stateSource,
    turnCapture: adapter.turns !== undefined,
    bookmarks: adapter.conversations !== undefined,
    inlineQuestions: adapter.questions !== undefined,
    commands: adapter.commands !== undefined,
    sandbox: adapter.sandbox !== undefined,
  }]));
}
