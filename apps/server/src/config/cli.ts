import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The pieces of the process a CLI entry reads and writes, injected so it can be tested in-process. */
export type CliContext = { args: string[]; env: NodeJS.ProcessEnv; cwd: string; out: (message: string) => void; err: (message: string) => void };

// whether this module is the process entry point, robust to symlinks and loader path forms
export function isCliEntry(moduleUrl: string, entry = process.argv[1]): boolean {
  if (entry === undefined) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entry); } catch { return false; }
}

/**
 * Run one CLI `main` from a module's top level, but only when that module is the process
 * entry point — importing it in a test triggers nothing. Loads the repository `.env` the
 * same way the server does, then wires the process streams into the injectable context.
 */
export async function runCli(moduleUrl: string, main: (context: CliContext) => Promise<number>): Promise<void> {
  if (!isCliEntry(moduleUrl)) return;
  const envFile = new URL('../../../../.env', moduleUrl);
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  process.exitCode = await main({ args: process.argv.slice(2), env: process.env, cwd: process.env.INIT_CWD ?? process.cwd(), out: message => process.stdout.write(message), err: message => process.stderr.write(message) });
}
