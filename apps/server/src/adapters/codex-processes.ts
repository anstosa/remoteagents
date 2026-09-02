import { basename } from 'node:path';
import { codexProgramName, nodeProgramName } from './program-names.js';

/**
 * Recognise the Codex process itself (ADR 0002): `comm` is `codex`, argv[0]'s
 * basename is `codex`, or `node` running a `codex` launcher script. This is a leaf
 * module — it imports only `node:path` and the program names — so the Codex Adapter
 * never depends on the process walker (which imports the registry, which imports
 * every Adapter).
 *
 * OMX is its own kind (ADR 0005): its wrapper never matches here. The walker checks
 * a pane's tree top-down, so it meets the OMX wrapper before the Codex child OMX
 * launches; a Codex process is claimed here only when no OMX ancestor was seen.
 */
export function isCodexCommand(comm: string, argv: readonly string[]): boolean {
  if (codexProgramName.test(comm)) return true;
  const program = basename(argv[0] ?? '');
  if (codexProgramName.test(program)) return true;
  return nodeProgramName.test(program) && argv.slice(1).some(argument => codexProgramName.test(basename(argument)));
}
