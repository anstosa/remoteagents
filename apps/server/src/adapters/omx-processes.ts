import { basename } from 'node:path';
import { nodeProgramName, omxProgramName } from './program-names.js';

/**
 * OMX (oh-my-codex) process identities (ADR 0005). OMX presents as the `omx`
 * executable, or as `node` running the packaged CLI entry (`…/dist/cli/omx.js`) —
 * the form every npm/mise install takes, since the bin shim execs node, and the
 * package's only `bin` (`dist/cli/index.js` beside it is the library the entry
 * imports, never a process). This is a leaf module: it imports only `node:path`
 * and the program names.
 */

/**
 * The argv index of the OMX entry — the `omx` executable, or the `omx.js` script
 * `node` runs — or -1 when this process is not OMX at all. In the node form the
 * script is the first argument that is not a node flag, so a later argument that
 * merely names a directory called `omx` (a `--cwd` value, say) is never the entry.
 * The subcommand and OMX's flags follow that index.
 */
export function omxEntryIndex(comm: string, argv: readonly string[]): number {
  const program = basename(argv[0] ?? '');
  if (nodeProgramName.test(program)) {
    const script = argv.findIndex((argument, index) => index > 0 && !argument.startsWith('-'));
    return script > 0 && omxProgramName.test(basename(argv[script]!)) ? script : -1;
  }
  return omxProgramName.test(program) || omxProgramName.test(comm) ? 0 : -1;
}

// OMX's own dispatcher (`resolveCliInvocation`) reads `--help`/`--version` before
// treating any other `--flag` first argument as the launch.
const informational = new Set(['--help', '--version']);

/**
 * Whether an OMX process is an Agent, decided exactly as OMX's own dispatcher
 * decides its command — from the first argument after the entry alone: absent,
 * `launch`, `resume`, or any `--flag` (the bare launch, with everything after it
 * OMX's or Codex's own arguments) runs the Codex TUI; any other first argument —
 * `hud`, `team`, `sidecar`, `mcp-serve`, `sparkshell`, `exec`, `update`, … — names
 * a helper. Console launches always lead with `--direct`, so an operator flag that
 * takes a value (`-c key=value`, `--model o3`) after it cannot hide the Agent.
 */
export function isOmxLeaderCommand(comm: string, argv: readonly string[]): boolean {
  const entry = omxEntryIndex(comm, argv);
  if (entry < 0) return false;
  const first = argv[entry + 1];
  if (first === undefined || first === 'launch' || first === 'resume') return true;
  return first.startsWith('--') && !informational.has(first);
}

/** An `omx hud --watch` process (direct or via node): a monitor, never an Agent. */
export function isHudWatcherCommand(cmdline: string): boolean {
  const argv = cmdline.split('\0').filter(Boolean);
  const entry = omxEntryIndex('', argv);
  return entry >= 0 && argv[entry + 1] === 'hud' && argv.slice(entry + 2).includes('--watch');
}
