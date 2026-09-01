import type { AdapterCapability, AgentKind } from '../adapters/types.js';

/**
 * Where the resolved Launch kind came from, shown against it in the Launch menu:
 * a scope's own last-used kind (`worktree` / `project` / `scratch`), or `default`
 * — the first launchable kind in registry order when nothing is remembered.
 */
export type LaunchOrigin = 'worktree' | 'project' | 'scratch' | 'default';
export type LaunchScope = 'worktree' | 'project' | 'scratch';

/** A remembered kind that could not be resolved because it is no longer launchable. */
export type SkippedLaunchProfile = { kind: AgentKind; origin: LaunchScope; reason: string };

/**
 * The Launch profile resolution the console publishes so the web renders the Launch
 * menu without re-deriving it (the resolution logic never leaves the server, ADR 0002):
 * which kind a one-click Launch uses, why, and any remembered kind it had to skip.
 * `kind`/`origin` are absent together when nothing is launchable.
 */
export type LaunchResolution = { kind?: AgentKind; origin?: LaunchOrigin; skipped?: SkippedLaunchProfile };

/**
 * Resolve which kind a Launch defaults to, and why. Remembered kinds are tried in
 * precedence order (worktree last-used → project last-used, or scratch); a remembered
 * kind that is no longer launchable is skipped and surfaced. When none are remembered
 * (or all are skipped) the first launchable kind in registry order wins as `default`.
 * Pure: `launchable` is the launchable kinds in registry order and `capabilities`
 * only supplies a skipped kind's reason.
 */
export function resolveLaunchProfile(
  launchable: readonly AgentKind[],
  remembered: ReadonlyArray<{ origin: LaunchScope; kind?: AgentKind }>,
  capabilities: Partial<Record<AgentKind, AdapterCapability>>,
): LaunchResolution {
  let skipped: SkippedLaunchProfile | undefined;
  for (const candidate of remembered) {
    if (candidate.kind === undefined) continue;
    if (launchable.includes(candidate.kind)) return { kind: candidate.kind, origin: candidate.origin, ...(skipped === undefined ? {} : { skipped }) };
    // remember the first still-configured-but-unlaunchable kind to explain the skip
    skipped ??= { kind: candidate.kind, origin: candidate.origin, reason: capabilities[candidate.kind]?.unavailableReason ?? 'no longer configured' };
  }
  const fallback = launchable[0];
  if (fallback === undefined) return skipped === undefined ? {} : { skipped };
  return { kind: fallback, origin: 'default', ...(skipped === undefined ? {} : { skipped }) };
}
