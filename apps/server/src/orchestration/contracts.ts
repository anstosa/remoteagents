import type { DashboardPayload } from '../dashboard/updates.js';
import type { GitComparisonSummary, GitStatusSummary, GitUpstreamSummary, PullRequestSummary, StackAction } from '../domain/models.js';
import type { AgentAttentionState } from '../notifications.js';
import type { PromptHistoryEntry } from '../prompt-history/service.js';
import type { QueuedPromptSummary } from '../prompts/queue.js';
import type { PullRequestSwitchAvailability } from '../pull-requests/switch-service.js';
import type { StoredReviewTour, StoredReviewTourSummary } from '../review-tour/contracts.js';
import type { ReviewTourInput } from '../review-tour/contracts.js';
import type { WorkspaceFilePreview } from '../workspace-files/service.js';
import type { StackOperationLog } from '../worktree-commands/service.js';

export const orchestrationContractVersion = 'v1' as const;

export type OrchestrationErrorCode = 'invalid_request' | 'not_found' | 'conflict' | 'unavailable' | 'operation_failed';
export type OrchestrationError = { code: OrchestrationErrorCode; message: string; retryable: boolean };
export type OrchestrationResult<T> =
  | { ok: true; version: typeof orchestrationContractVersion; value: T }
  | { ok: false; version: typeof orchestrationContractVersion; error: OrchestrationError };

export type InstanceV1 = {
  id: string;
  name: string;
  url: string;
  local: boolean;
  icon?: string;
};

export type AgentStatusV1 = {
  id: string;
  title: string;
  label: string;
  projectId?: string;
  worktreeId?: string;
  branch?: string;
  gitStatus?: GitStatusSummary;
  gitPrStatus?: GitComparisonSummary;
  gitUpstream?: GitUpstreamSummary;
  pullRequest?: PullRequestSummary;
  projectUrl?: string;
  question?: { id: string; text: string; choices: string[] };
  attention: AgentAttentionState;
  unread: boolean;
};

export type StackStateV1 = {
  actions: StackAction[];
  running?: boolean;
  transition?: 'starting' | 'migrating';
  operation?: StackAction;
  tunnel?: boolean;
};

export type WorktreeStatusV1 = {
  id: string;
  label: string;
  available: boolean;
  pinned: boolean;
  active: boolean;
  order: number;
  agentIds: string[];
  projectUrl?: string;
  branch?: string;
  gitStatus?: GitStatusSummary;
  gitPrStatus?: GitComparisonSummary;
  gitUpstream?: GitUpstreamSummary;
  pullRequest?: PullRequestSummary;
  stack?: StackStateV1;
  review?: StoredReviewTourSummary;
};

export type LatestResponseV1 = {
  text: string;
  source: 'terminal' | 'history';
  truncated: boolean;
};

export type LogTailV1 = {
  text: string;
  rows: number;
  older: boolean;
  truncated: boolean;
};

export type PromptHistoryV1 = { prompts: PromptHistoryEntry[] };
export type QueuedPromptsV1 = { prompts: QueuedPromptSummary[] };
export type FilePreviewV1 = WorkspaceFilePreview;

export type PullRequestStatusV1 = {
  current?: PullRequestSummary;
  comparison?: GitComparisonSummary;
  switching?: PullRequestSwitchAvailability;
  actionsUrl?: string;
};

export type ReviewStatusV1 = {
  summary?: StoredReviewTourSummary;
  review?: StoredReviewTour;
};

export type StackStatusV1 = StackStateV1 & { log?: StackOperationLog };

export type WorkspaceSummaryEntryV1 = {
  id: string;
  label: string;
  active: boolean;
  agents: number;
  attention: AgentAttentionState | 'inactive';
  branch?: string;
  changes: number;
};

export type WorkspaceSummaryV1 = {
  text: string;
  worktrees: WorkspaceSummaryEntryV1[];
  scratchAgents: Array<{ id: string; label: string; attention: AgentAttentionState }>;
};

export type AttentionSummaryV1 = {
  state: 'idle' | 'working' | 'question' | 'completed';
  text: string;
  agents: Array<{ id: string; label: string; attention: AgentAttentionState; unread: boolean }>;
};

export type PreviewFileInputV1 = {
  path: string;
  agentId?: string;
  worktreeId?: string;
  maxBytes?: number;
};

export type QueuePromptInputV1 = { agentId: string; prompt: string };
export type UpdateQueuedPromptInputV1 = { agentId: string; promptId: string; prompt: string };
export type MoveQueuedPromptInputV1 = { agentId: string; promptId: string; direction: 'earlier' | 'later' };
export type RemoveQueuedPromptInputV1 = { agentId: string; promptId: string };
export type AnswerQuestionInputV1 = { agentId: string; questionId: string; index: number };
export type RunStackActionInputV1 = { worktreeId: string; action: StackAction };
export type SwitchPullRequestInputV1 = { agentId: string; number: number };
export type StartReviewInputV1 = { agentId: string } & ReviewTourInput;

export type EnrichedDashboard = DashboardPayload;
