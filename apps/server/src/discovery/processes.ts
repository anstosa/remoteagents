import { readFile, readdir } from 'node:fs/promises';
import { recognizeProcess } from '../adapters/registry.js';
import type { AgentKind } from '../adapters/types.js';
const allowed = /^(codex|omx)(?:\.js)?$/i;
const codex = /^codex(?:\.js)?$/i;
const node = /^(?:node|nodejs)(?:\.exe)?$/i;
// srt/bwrap are the sandbox wrappers; an agent found beneath one is `wrapped`.
const sandboxWrapper = /^(?:bwrap|srt)$/u;

export function isAgentCommand(comm: string, cmdline: string): boolean {
  if (allowed.test(comm)) return true;
  const args = cmdline.split('\0').filter(Boolean);
  const program = args[0]?.split('/').pop() ?? '';
  if (allowed.test(program)) return true;
  return node.test(program) && args.slice(1).some(arg => codex.test(arg.split('/').pop() ?? ''));
}

export function isHudWatcherCommand(cmdline: string): boolean {
  const args = cmdline.split('\0').filter(Boolean);
  const executable = args[0]?.split('/').pop() ?? '';
  const omxIndex = /^(?:omx|omx\.js)$/iu.test(executable)
    ? 0
    : node.test(executable) ? args.findIndex((arg, index) => index > 0 && /^(?:omx|omx\.js)$/iu.test(arg.split('/').pop() ?? '')) : -1;
  return omxIndex >= 0 && args[omxIndex + 1] === 'hud' && args.slice(omxIndex + 2).includes('--watch');
}

export type HostProcess = { pid: number; parentPid: number; startTime: string; comm: string; cmdline: string };
export interface HostProcessInspector { listProcesses(): Promise<HostProcess[]>; }

// One recognised agent beneath a pane: its kind, its own pid, and whether a
// bwrap/srt sandbox wrapper was seen on the way to it (a generic cross-check).
export type RecognizedAgent = { kind: AgentKind; pid: number; wrapped: boolean };

export interface ProcessInspector { recognizeAgent(pid: number): Promise<RecognizedAgent | undefined>; }
export class ProcInspector implements ProcessInspector {
  private readonly procRoot = process.env.RAC_HOST_PROC ?? '/proc';
  // walk one pane tree, asking every registered Adapter (registry order) per process
  async recognizeAgent(root: number): Promise<RecognizedAgent | undefined> {
    // carry wrapper-ancestry per path, so `wrapped` reflects this agent's own ancestors, not a sibling branch's
    const pending: Array<{ pid: number; wrappedAbove: boolean }> = [{ pid: root, wrappedAbove: false }];
    const seen = new Set<number>();
    while (pending.length && seen.size < 256) {
      const { pid, wrappedAbove } = pending.pop()!;
      if (seen.has(pid)) continue;
      seen.add(pid);
      try {
        const comm = (await readFile(`${this.procRoot}/${pid}/comm`, 'utf8')).trim();
        const cmdline = await readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8');
        const adapter = recognizeProcess({ comm, argv: cmdline.split('\0').filter(Boolean) });
        if (adapter !== undefined) return { kind: adapter.kind, pid, wrapped: wrappedAbove };
        const wrappedBelow = wrappedAbove || sandboxWrapper.test(comm);
        const children = (await readFile(`${this.procRoot}/${pid}/task/${pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean).map(Number);
        for (const child of children) if (Number.isInteger(child) && child > 0) pending.push({ pid: child, wrappedAbove: wrappedBelow });
      } catch { /* exited/unreadable is not an agent */ }
    }
    return undefined;
  }

  async listProcesses(): Promise<HostProcess[]> {
    const entries = await readdir(this.procRoot, { withFileTypes: true }).catch(() => []);
    const processes: HostProcess[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
      const pid = Number(entry.name);
      try {
        const [comm, cmdline, stat] = await Promise.all([
          readFile(`${this.procRoot}/${pid}/comm`, 'utf8'),
          readFile(`${this.procRoot}/${pid}/cmdline`, 'utf8'),
          readFile(`${this.procRoot}/${pid}/stat`, 'utf8')
        ]);
        const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/u);
        const parentPid = Number(fields[1]);
        const startTime = fields[19];
        if (Number.isInteger(parentPid) && parentPid >= 0 && startTime) processes.push({ pid, parentPid, startTime, comm: comm.trim(), cmdline });
      } catch { /* exited or unreadable */ }
    }
    return processes;
  }
}
export async function tmuxServerPids(uid: number): Promise<number[]> { const procRoot = process.env.RAC_HOST_PROC ?? '/proc'; const entries = await readdir(procRoot, { withFileTypes: true }); const found: number[] = []; for (const entry of entries) { if (!/^\d+$/.test(entry.name)) continue; try { const status = await readFile(`${procRoot}/${entry.name}/status`, 'utf8'); if (!new RegExp(`^Uid:\\s+${uid}\\b`, 'm').test(status)) continue; const cmd = await readFile(`${procRoot}/${entry.name}/cmdline`, 'utf8'); if (/\btmux(?::|\0).*server|tmux: server/.test(cmd)) found.push(Number(entry.name)); } catch { } } return found; }
