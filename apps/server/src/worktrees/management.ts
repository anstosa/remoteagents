import { access, mkdir, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Project } from '../domain/models.js';
import { run } from '../tmux/command.js';

/**
 * The git subprocess seam for Worktree management, always spawning `/usr/bin/git`.
 * Returns `stderr` (unlike the discovery `GitRun`) because git's trimmed stderr is the
 * backstop error text a refused `worktree add` surfaces to the operator. Injected so
 * tests assert flag composition and stage refusals without a real repository.
 */
export type GitExec = (args: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;
const defaultGit: GitExec = (args, timeoutMs) => run('/usr/bin/git', args, undefined, timeoutMs);

// git `worktree add` may clone a large tree; the shared executor's default 5s is not enough
const addTimeoutMs = 120_000;

/** One offerable branch for the Add "existing" picker; `remote` marks a remote-only ref. */
export type BranchOption = { name: string; remote: boolean };
export type BranchesResult = { ok: true; branches: BranchOption[]; defaultBranch?: string } | { ok: false; status: number; error: string };
export type AddInput = { mode: 'new' | 'existing'; branch: string; base?: string };
export type AddResult = { ok: true; path: string } | { ok: false; status: number; error: string };

/**
 * Whether the console may create or remove Worktrees in this Project. A missing or
 * non-git checkout cannot be managed; under the Docker bridge a Project whose container
 * path differs from its host path is refused, because git would otherwise write the
 * container's paths into worktree metadata the host cannot follow (ADR 0003).
 */
export function worktreeManagementAvailability(project: Project): { available: boolean; reason?: string } {
  if (!project.available) return { available: false, reason: project.unavailableReason ?? `project ${project.id} is unavailable` };
  if (project.hostPath !== undefined && project.hostPath !== project.path) {
    return { available: false, reason: 'the container does not mount this project at its host path, so git cannot manage its worktrees' };
  }
  return { available: true };
}

// a branch name legal for the git checkout and safe as a single path leaf: no traversal,
// no control characters, and accepted by `git check-ref-format --branch`
function invalidBranchReason(branch: string): string | undefined {
  if (branch.length === 0 || branch.length > 255) return 'branch name is required';
  // `--branch` treats a leading `-` or `@{…}` specially; reject before it reaches git
  if (branch.startsWith('-') || branch.includes('..') || branch.includes('@{') || /[\0\n\r\t~^:?*[\\ ]/u.test(branch)) return `\`${branch}\` is not a valid branch name`;
  return undefined;
}

// the checkout path for a branch: its name with `/` flattened to `-`, under the Project's
// Worktrees directory. Returns undefined when the leaf would escape that directory.
function worktreePath(worktreesDirectory: string, branch: string): string | undefined {
  const leaf = branch.replaceAll('/', '-');
  const path = resolve(worktreesDirectory, leaf);
  return path === worktreesDirectory || !path.startsWith(worktreesDirectory + sep) ? undefined : path;
}

export class WorktreeManagementService {
  // one Add runs at a time per Project, so two concurrent creations never race on git's
  // worktree metadata or on the same leaf directory
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly projects: () => Project[], private readonly git: GitExec = defaultGit) {}

  private project(projectId: string): Project | undefined {
    return this.projects().find(project => project.id === projectId);
  }

  // serialize an operation onto this Project's chain
  private serialize<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(projectId) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.chains.set(projectId, next.then(() => undefined, () => undefined));
    return next;
  }

  // the offerable branches (local checked out nowhere, plus remote-only) and the resolved
  // default branch (`origin/HEAD`, else the checkout's HEAD) for the Add dialog
  async branches(projectId: string): Promise<BranchesResult> {
    const project = this.project(projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    const listed = await this.git(['-C', project.path, 'for-each-ref', '--format', '%(refname)\t%(worktreepath)', 'refs/heads', 'refs/remotes']);
    if (listed.code !== 0) return { ok: false, status: 409, error: (listed.stderr.trim() || 'could not list branches') };
    const localCheckedOutNowhere: BranchOption[] = [];
    const localNames = new Set<string>();
    const remoteOnly = new Map<string, BranchOption>();
    for (const line of listed.stdout.split('\n')) {
      if (line === '') continue;
      const tab = line.indexOf('\t');
      const refname = tab === -1 ? line : line.slice(0, tab);
      const worktreepath = tab === -1 ? '' : line.slice(tab + 1);
      if (refname.startsWith('refs/heads/')) {
        const name = refname.slice('refs/heads/'.length);
        localNames.add(name);
        if (worktreepath === '') localCheckedOutNowhere.push({ name, remote: false });
      } else if (refname.startsWith('refs/remotes/')) {
        const rest = refname.slice('refs/remotes/'.length);
        const slash = rest.indexOf('/');
        // skip a remote's symbolic HEAD (`refs/remotes/origin/HEAD`), never a real branch
        const name = slash === -1 ? '' : rest.slice(slash + 1);
        if (name !== '' && name !== 'HEAD' && !remoteOnly.has(name)) remoteOnly.set(name, { name, remote: true });
      }
    }
    const branches = [...localCheckedOutNowhere, ...[...remoteOnly.values()].filter(option => !localNames.has(option.name))];
    const defaultBranch = await this.defaultBranch(project.path);
    return { ok: true, branches, ...(defaultBranch === undefined ? {} : { defaultBranch }) };
  }

  // `origin/HEAD` when the remote publishes one, else the checkout's own HEAD branch
  private async defaultBranch(path: string): Promise<string | undefined> {
    const origin = await this.git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    if (origin.code === 0) { const ref = origin.stdout.trim(); const slash = ref.indexOf('/'); if (ref !== '') return slash === -1 ? ref : ref.slice(slash + 1); }
    const head = await this.git(['-C', path, 'symbolic-ref', '--short', 'HEAD']);
    return head.code === 0 && head.stdout.trim() !== '' ? head.stdout.trim() : undefined;
  }

  // create a Worktree for a new or existing branch, returning its realpath'd root. Every
  // refusal is a 409 raised before git runs; git's own failure carries its trimmed stderr.
  async add(projectId: string, input: AddInput): Promise<AddResult> {
    const project = this.project(projectId);
    if (project === undefined) return { ok: false, status: 404, error: 'project unavailable' };
    const availability = worktreeManagementAvailability(project);
    if (!availability.available) return { ok: false, status: 409, error: availability.reason! };
    if (input.mode !== 'new' && input.mode !== 'existing') return { ok: false, status: 400, error: 'invalid worktree mode' };
    const branchIssue = invalidBranchReason(input.branch);
    if (branchIssue !== undefined) return { ok: false, status: 409, error: branchIssue };
    const path = worktreePath(project.worktreesDirectory, input.branch);
    if (path === undefined) return { ok: false, status: 409, error: 'branch name does not map to a safe worktree path' };
    return await this.serialize(projectId, () => this.runAdd(project, input, path));
  }

  private async runAdd(project: Project, input: AddInput, path: string): Promise<AddResult> {
    if (!await this.refFormatValid(input.branch)) return { ok: false, status: 409, error: `\`${input.branch}\` is not a valid branch name` };
    if (input.mode === 'new') {
      if (await this.branchExists(project.path, input.branch)) return { ok: false, status: 409, error: `branch \`${input.branch}\` already exists` };
    } else if (await this.checkedOutElsewhere(project.path, input.branch)) {
      return { ok: false, status: 409, error: `branch \`${input.branch}\` is already checked out` };
    }
    let base: string | undefined;
    if (input.mode === 'new') {
      base = input.base ?? await this.defaultBranch(project.path);
      if (base === undefined || base.trim() === '') return { ok: false, status: 409, error: 'a base branch or commit is required' };
      // a leading `-` is never a valid commit-ish and would let git read the base as a flag
      if (base.startsWith('-')) return { ok: false, status: 409, error: `base \`${base}\` is not valid` };
      if (!await this.commitResolves(project.path, base)) return { ok: false, status: 409, error: `base \`${base}\` does not resolve to a commit` };
    }
    if (await this.pathExists(path)) return { ok: false, status: 409, error: 'the target worktree path already exists' };
    await mkdir(project.worktreesDirectory, { recursive: true });
    const args = input.mode === 'new'
      ? ['-C', project.path, 'worktree', 'add', '--no-track', '-b', input.branch, path, base!]
      : ['-C', project.path, 'worktree', 'add', path, input.branch];
    const created = await this.git(args, addTimeoutMs);
    if (created.code !== 0) return { ok: false, status: 409, error: (created.stderr.trim() || 'git worktree add failed') };
    return { ok: true, path: await realpath(path).catch(() => path) };
  }

  private async refFormatValid(branch: string): Promise<boolean> {
    return (await this.git(['check-ref-format', '--branch', branch])).code === 0;
  }
  private async branchExists(path: string, branch: string): Promise<boolean> {
    return (await this.git(['-C', path, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
  }
  private async commitResolves(path: string, base: string): Promise<boolean> {
    return (await this.git(['-C', path, 'rev-parse', '--verify', '--quiet', `${base}^{commit}`])).code === 0;
  }
  private async checkedOutElsewhere(path: string, branch: string): Promise<boolean> {
    const listed = await this.git(['-C', path, 'for-each-ref', '--format', '%(worktreepath)', `refs/heads/${branch}`]);
    return listed.code === 0 && listed.stdout.trim() !== '';
  }
  private async pathExists(path: string): Promise<boolean> {
    return await access(path).then(() => true, () => false);
  }
}
