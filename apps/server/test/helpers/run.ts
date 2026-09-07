import type { Agent, Dashboard, SocketRef, Worktree } from '../../src/domain/models.js';

/**
 * The fakes the Run primitive's HTTP-seam tests drive `buildApp` with, kept here so the
 * later Run tickets (reuse-a-pane, unattended firing) reuse the same counter-driven
 * discovery, recording tmux, fake launch service and zero poll delay (Scheduled prompts).
 */

/** A `launchPollDelay` that never waits, so the sixty-second poll runs at full speed in tests. */
export const zeroPollDelay = async (): Promise<void> => {};

/** A launch service whose `launch` succeeds unless `refuse` is set; records the kinds it saw. */
export function launchFake(options: { refuse?: boolean } = {}): { launch: (worktreeId: string, kind?: string) => Promise<boolean>; kinds: Array<string | undefined> } {
  const kinds: Array<string | undefined> = [];
  return { launch: async (_worktreeId, kind) => { kinds.push(kind); return !options.refuse; }, kinds };
}

/**
 * A discovery stub over one Worktree and one agent: the agent is absent from the
 * dashboard until after `appearAfter` snapshots (so `waitForAgent` finds it on a later
 * poll, or never when `appearAfter` is `Infinity`), while `target` always resolves it so
 * the readiness poll can read its pane.
 */
export function appearingDiscovery(params: { worktree: Worktree; agent: Agent; socket: SocketRef; appearAfter?: number }): {
  invalidateWorktrees: () => void;
  worktreesNow: () => Worktree[];
  worktrees: () => Promise<Worktree[]>;
  dashboard: () => Promise<Dashboard>;
  target: (id: string) => Promise<{ agent: Agent; socket: SocketRef } | undefined>;
} {
  const { worktree, agent, socket } = params;
  const appearAfter = params.appearAfter ?? 1;
  let dashboards = 0;
  return {
    invalidateWorktrees: () => {},
    worktreesNow: () => [worktree],
    worktrees: async () => [worktree],
    dashboard: async () => ({ generation: ++dashboards, adapters: {}, agents: dashboards > appearAfter ? [agent] : [], projects: [] }),
    target: async (id: string) => (id === agent.id ? { agent, socket } : undefined),
  };
}

/**
 * A recording tmux whose `capture` reflects the last pasted draft (`› <draft>`), so
 * Codex reads the composer as ready and the pasted prompt as visible then cleared —
 * the shape the queued-prompt tests already rely on. Pass `capture` to force a fixed
 * screen instead (a Claude safety check, or a still-loading Codex header). `pasted` and
 * `closed` record the pastes and pane closes the Run drove.
 */
export function recordingTmux(options: { capture?: () => string } = {}): {
  capture: () => Promise<string>;
  pastePrompt: (socket: SocketRef, pane: string, buffer: string, text: string) => Promise<boolean>;
  sendKeys: () => Promise<boolean>;
  close: (socket: SocketRef, pane: string) => Promise<boolean>;
  label: () => Promise<boolean>;
  pasted: string[];
  closed: string[];
} {
  const pasted: string[] = [];
  const closed: string[] = [];
  let draft = '';
  return {
    capture: async () => (options.capture ? options.capture() : `› ${draft}`),
    pastePrompt: async (_socket, _pane, _buffer, text) => { draft = text; pasted.push(text); return true; },
    // Enter clears the composer, so the submission reads as accepted
    sendKeys: async () => { draft = ''; return true; },
    close: async (_socket, pane) => { closed.push(pane); return true; },
    label: async () => true,
    pasted,
    closed,
  };
}
