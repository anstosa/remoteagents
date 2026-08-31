import { resolveAttention } from '../../src/adapters/attention.js';
import type { AttentionState } from '../../src/adapters/types.js';

/**
 * Stamp a test agent with the `kind` and resolved `attention` DiscoveryService
 * would give it. `attention` is a getter over the current `title`, so a test
 * that mutates `.title` in place to drive a state transition gets the matching
 * state without also updating `.attention` by hand. Note the getter does not
 * survive a spread: `{ ...stated(agent), title: '⠋ Working' }` freezes the old
 * attention — re-wrap such a copy with `stated(...)`.
 */
export const stated = <T extends { title: string; question?: unknown }>(a: T): T & { kind: 'codex'; attention: AttentionState } => {
  Object.defineProperty(a, 'attention', {
    enumerable: true,
    configurable: true,
    get() { return resolveAttention({ kind: 'codex', title: a.title, hasQuestion: a.question !== undefined }); }
  });
  return Object.assign(a, { kind: 'codex' as const }) as T & { kind: 'codex'; attention: AttentionState };
};
