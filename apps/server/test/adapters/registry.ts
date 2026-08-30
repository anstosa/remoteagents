import type { AdapterContract } from './contract.js';
import { codexShim } from './codex-shim.js';

/**
 * The adapters the contract suite runs. Today this is the Codex shim over the
 * live functions; chunk 1 commit 2 replaces it with the real Adapter registry
 * from `src`, and the suite keeps running unchanged.
 */
export const adaptersUnderTest: AdapterContract[] = [codexShim];
