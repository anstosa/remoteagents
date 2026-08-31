import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

/**
 * Shared fixture plumbing for the Codex rollout tests: throwaway directories
 * for `CODEX_HOME` and the fake `/proc` tree the fd-walk reads. Importing this
 * module registers one `afterEach` in the importing file that removes every
 * directory handed out and restores `RAC_HOST_PROC`/`CODEX_HOME` to what they
 * were when the file loaded — tests only set the env and go.
 */
const cleanups: string[] = [];
const savedEnv = { proc: process.env.RAC_HOST_PROC, home: process.env.CODEX_HOME };

afterEach(async () => {
  if (savedEnv.proc === undefined) delete process.env.RAC_HOST_PROC; else process.env.RAC_HOST_PROC = savedEnv.proc;
  if (savedEnv.home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = savedEnv.home;
  await Promise.all(cleanups.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** One tracked throwaway directory, removed after the test. */
export async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanups.push(directory);
  return directory;
}

/** A throwaway `CODEX_HOME` for rollout fixtures. */
export function codexHome(): Promise<string> {
  return tempDir('rac-codex-home-');
}

/** A fake `/proc` tree whose one pid holds the given files open (none = a blocked readlink). */
export async function fakeProc(pid: number, files: string[]): Promise<string> {
  const proc = await tempDir('rac-proc-');
  await mkdir(join(proc, String(pid), 'task', String(pid)), { recursive: true });
  await writeFile(join(proc, String(pid), 'task', String(pid), 'children'), '');
  const fd = join(proc, String(pid), 'fd');
  await mkdir(fd, { recursive: true });
  await Promise.all(files.map((file, index) => symlink(file, join(fd, String(index + 3)))));
  return proc;
}
