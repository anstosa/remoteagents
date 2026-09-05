import type { AdapterCapability, AgentKind, AttentionState, InlineQuestion } from '../adapters/types.js';

export type SocketRef = { fingerprint: string; path: string; device: number; inode: number };
export type Pane = { paneId: string; sessionId: string; sessionName?: string; pid: number; path: string; title: string; displayLabel?: string; command: string; startCommand?: string; reportedAttention?: string; reportedSession?: string; reportedSandboxed?: string; reportedQuestion?: string; consoleManaged?: boolean; socket: SocketRef };
export type PullRequestIssues = { mergeConflicts?: boolean; failingChecks?: boolean; unresolvedComments?: boolean };
export type PullRequestCheckStatus = 'passed' | 'pending' | 'failed';
export type PullRequestSummary = { number: number; title: string; status: 'draft' | 'open' | 'merged'; url: string; baseBranch?: string; checks?: PullRequestCheckStatus; issues?: PullRequestIssues };
export const stackActions = ['start', 'stop', 'build', 'restart', 'migrate'] as const;
export type StackAction = typeof stackActions[number];
export type StackCommands = Partial<Record<StackAction | 'status', string>>;
// canonical checkout settings with project defaults already resolved
export type WorktreeOverride = { path: string; commands?: StackCommands; projectUrl?: string; projectPort?: number };
export type PromptAction = { label: string; prompt: string };
export type GitStatusChange = { code: string; path: string; originalPath?: string; additions?: number; deletions?: number; category?: 'implementation' | 'test' | 'doc' };
export type GitStatusSummary = { files: number; staged: number; unstaged: number; untracked: number; conflicted: number; changes?: GitStatusChange[] };
export type GitComparisonSummary = { base: string; files: number; changes?: GitStatusChange[] };
export type GitUpstreamSummary = { upstream: string; ahead: number; behind: number };
export type Agent = { id: string; paneId: string; sessionId: string; socketFingerprint: string; workspace: string; branch?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; title: string; kind: AgentKind; attention: AttentionState; sandboxed?: boolean; conversationId?: string; displayLabel?: string; projectId?: string; worktreeId?: string; newTaskConfigured?: boolean; push?: PromptAction; projectUrl?: string; pullRequest?: PullRequestSummary; question?: InlineQuestion };
/**
 * A configured directory the console manages (config `projects[]`). A `repository`
 * Project's identity is the realpath of its common git directory, so two entries
 * pointing at the same repository are refused as duplicates and a Project may be
 * configured through any of its checkouts (ADR 0003). A `directory` Project's path
 * exists but is not a git checkout: it has no Worktrees and an agent launches directly
 * in it, like Scratch, so its identity is just its own realpath'd path. `path` is
 * unavailable only when it is missing at boot, which loads the Project as
 * `available: false` rather than failing to boot. stack commands and preview settings
 * are defaults; canonical worktree overrides replace them for individual checkouts.
 * discovered worktrees denormalise the resolved settings for convenience.
 */
export type Project = { id: string; label: string; path: string; identity: string; mode: 'repository' | 'directory'; hostPath?: string; worktreeOrder?: string[]; worktreeOverrides?: WorktreeOverride[]; worktreesDirectory: string; available: boolean; unavailableReason?: string; commands?: StackCommands; newTask?: string; push: PromptAction; projectUrl?: string; projectPort?: number };
/**
 * One checkout of a Project as `git worktree list` reports it, keyed by the wire id
 * `<projectId>:<realpath>` (ADR 0003). `identity` equals the checkout's realpath
 * (this Worktree's own git toplevel) and is what an Agent's workspace matches; a
 * Docker main Worktree also matches its `hostPath`. `main`/`detached`/`locked` come
 * from git; a Stale worktree (git's `prunable`) is excluded by discovery, never carried
 * here. `pinned` and `customLabel` identify the operator's per-Worktree choices from
 * `.data`. resolved stack commands and preview settings, plus project-wide newTask/push,
 * are copied on so worktree-scoped services keep reading them from the worktree.
 */
export type Worktree = { id: string; projectId: string; label: string; customLabel?: boolean; path: string; identity: string; hostPath?: string; available: boolean; pinned: boolean; main: boolean; detached: boolean; locked: boolean; lockedReason?: string; branch?: string; sha?: string; commands?: StackCommands; newTask?: string; push?: PromptAction; projectUrl?: string; projectPort?: number };
export type CleanupTargetKind = 'orphan-worker' | 'stale-agent' | 'hud-pane' | 'hud-process';
export type CleanupTarget = { id: string; kind: CleanupTargetKind; label: string; detail: string };
/**
 * One Worktree on the wire. Carries the git identity fields the web renders (label,
 * whether that label was explicitly saved, branch/sha, main/detached/locked, pin), a stable tab `order`, and — for a Worktree
 * with no live Agent — the same idle git metadata the flat list used to carry. Active
 * Worktrees omit the metadata (their Agent carries it).
 */
export type DashboardWorktree = { id: string; projectId: string; label: string; customLabel?: boolean; path: string; available: boolean; pinned: boolean; main: boolean; detached: boolean; locked: boolean; order: number; branch?: string; sha?: string; projectUrl?: string; gitStatus?: GitStatusSummary; gitPrStatus?: GitComparisonSummary; gitUpstream?: GitUpstreamSummary; pullRequest?: PullRequestSummary };
// `manageWorktrees` (with a reason when false) gates the Add/Remove/Prune controls: a
// Project whose checkout is missing, which is a non-git `directory` Project, or which the
// Docker bridge does not mount at its host path, cannot have Worktrees created or removed
// even when its Worktrees still show. `mode` distinguishes a git `repository` (launched
// through its Worktrees) from a non-git `directory` (launched in place, like Scratch — the
// web renders a Project-level Launch button for it). `stalePaths` are the checkouts an
// explicit Prune would clear (git's prunable entries plus console records whose path git
// lists nowhere, ADR 0003); the Project header shows their count as `N stale · Prune` and
// the confirm lists them by path. Empty when nothing is stale.
export type DashboardProject = { id: string; label: string; mode: 'repository' | 'directory'; available: boolean; unavailableReason?: string; manageWorktrees: boolean; manageWorktreesReason?: string; stalePaths: string[]; worktrees: DashboardWorktree[] };
export type Dashboard = { generation: number; serverStartedAt?: number; adapters: Partial<Record<AgentKind, AdapterCapability>>; agents: Agent[]; projects: DashboardProject[] };
