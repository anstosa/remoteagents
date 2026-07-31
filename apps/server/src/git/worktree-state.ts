import { run } from '../tmux/command.js';

export type GitCommand = (binary: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export async function cleanAndPushedOrDetached(workspace: string, command: GitCommand = run): Promise<boolean> {
  const status = await command('/usr/bin/git', ['-C', workspace, 'status', '--porcelain=v1']);
  if (status.code !== 0 || status.stdout.trim()) return false;
  const branch = await command('/usr/bin/git', ['-C', workspace, 'symbolic-ref', '--quiet', 'HEAD']);
  if (branch.code !== 0) return true;
  const remoteRefs = await command('/usr/bin/git', ['-C', workspace, 'for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/remotes/origin/']);
  if (remoteRefs.code === 0 && remoteRefs.stdout.trim()) return true;
  const upstream = await command('/usr/bin/git', ['-C', workspace, 'for-each-ref', '--format=%(upstream:track)', branch.stdout.trim()]);
  return upstream.code === 0 && upstream.stdout.trim() === '[gone]';
}
