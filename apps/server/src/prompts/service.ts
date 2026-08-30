import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { failedTurnFromCapture, lastPromptFromHistory, latestCompletedAssistantTurn, queueReadyPrompt } from '../adapters/codex-turns.js';
import { adapterFor } from '../adapters/registry.js';
import type { Adapter, AgentKind, SubmissionMode, TmuxKey } from '../adapters/types.js';
import { omxQuestion } from '../discovery/service.js';
import type { Agent, Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import type { SavedPromptService } from '../saved-prompts/service.js';
import { agentAttentionState } from '../notifications.js';
import { QueuedPromptService, type QueuedPromptSummary } from './queue.js';
import { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentData, promptAttachmentName, validPrompt, validPromptAttachments, type PromptAttachment } from './validation.js';
import { configuredWorktreeForWorkspace } from '../workspaces/resolver.js';
import { isUpdateAdvisorLabel, updateAdvisorLabel, updateAdvisorPendingLabel } from '../update-advisor.js';
import { isFullGitSha } from '../git/revision.js';
export { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';

const answerCaptureGraceMs = 10_000;
// a reported-state prompt must report `working` within this window or the dispatch is failed
const reportedWorkingGraceMs = 5_000;
// an interactive submit key (Codex's Tab) is swallowed when it races a composer
// that has not yet rendered the paste; wait (briefly, bounded) for the paste to
// land before submitting. Best-effort: if it never renders, submit anyway.
const composerRenderAttempts = 12;
const composerRenderPollMs = 50;
// the console never composes submission through an unknown kind
type AdapterView = Pick<Adapter, 'stateSource' | 'submission' | 'turns'>;
type CancelOutcome = 'ok' | 'unavailable' | 'not-working';
// an Adapter that announces its own Attention state (rather than the console
// inferring it from the title): it must report `working` before a prompt counts
// as complete, and fires no Stop hook on an interrupt, so the console writes
// `finished` itself.
const reportsOwnState = (adapter: AdapterView) => adapter.stateSource !== 'title';
const attachmentIgnoreRule = '/node_modules/.remote-agent-console/';
const updateAdvisorComposerAttempts = 100;
const updateAdvisorReadyStableMs = 500;
const updateAdvisorStartAttempts = 50;
const updateAdvisorPollMs = 100;
// normalize terminal-wrapped prompts
const normalizedPrompt = (value: string) => value.replace(/\s+/gu, ' ').trim();
// normalize one styled terminal snapshot
const normalizedTerminalText = (value: string) => normalizedPrompt(value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, ''));
type PromptCompletion = 'completed' | 'failed' | 'pending';
type PromptReconciliation = 'pending' | 'settled' | 'recorded';
type PromptPhase = { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; historyEntryId?: string; historyPrompt?: string; baselineCompletion?: string };
type DiscoveredTarget = NonNullable<Awaited<ReturnType<DiscoveryService['target']>>>;
export class PromptService {
  private readonly phases = new Map<string, PromptPhase>();
  private readonly dispatching = new Set<string>();
  private readonly reconciled = new Set<string>();
  // track work observed after service startup
  private readonly observedWorking = new Set<string>();
  private readonly reconciliationPendingSince = new Map<string, number>();
  private readonly restartLocks = new Set<string>();
  private readonly lockedAgentIds = new Set<string>();
  private readonly activeMutations = new Map<string, number>();
  private readonly mutationVersions = new Map<string, number>();
  private lifecycleMutationVersion = 0;

  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly worktrees: Worktree[] = [], private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService, private readonly saved?: SavedPromptService, private readonly resolveAdapter: (kind: AgentKind) => AdapterView | undefined = adapterFor) {}

  // submit or durably queue one prompt
  async submit(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    if (!validPrompt(prompt, attachments)) return false;
    const releaseMutation = this.beginAgentMutation(agentId);
    const first = await this.discovery.target(agentId);
    // release reservations for vanished targets
    if (!first) {
      releaseMutation?.();
      return false;
    }
    const scope = this.historyScope(first.agent, agentId);
    // queue work arriving during a restart handoff
    if (releaseMutation === undefined || this.restartLocks.has(scope)) {
      releaseMutation?.();
      return this.queued !== undefined && await this.queued.enqueue(scope, prompt, attachments) !== undefined;
    }
    try {
      const waiting = await this.queued?.list(scope);
      // retain prompts behind active or halted work
      if (this.queued !== undefined && (agentAttentionState(first.agent) !== 'finished' || this.phases.has(scope) || (waiting?.length ?? 0) > 0)) {
        const busy = agentAttentionState(first.agent) !== 'finished';
        const baselineCompletion = busy && !this.phases.has(scope) ? await this.completionSignature(agentId) : undefined;
        const queued = await this.queued.enqueue(scope, prompt, attachments);
        // track work that started outside the managed prompt flow
        if (queued !== undefined && busy && !this.phases.has(scope)) this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }) });
        return queued !== undefined;
      }
      return await this.send(agentId, prompt, attachments, first);
    } finally {
      releaseMutation();
    }
  }

  // submit one server-owned advisor prompt directly
  async submitUpdateAdvisor(agentId: string, targetSha: string, prompt: string): Promise<boolean> {
    // require one exact pending advisor and valid generated prompt
    if (!isFullGitSha(targetSha) || !validPrompt(prompt, [])) return false;
    const target = await this.discovery.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.send(agentId, prompt, [], target, 'confirmed-enter');
  }

  // mark one advisor reusable only after its initial prompt is scheduled
  async markUpdateAdvisorReady(agentId: string, targetSha: string): Promise<boolean> {
    // require one server-owned target and live advisor pane
    if (!isFullGitSha(targetSha)) return false;
    const target = await this.discovery.target(agentId);
    if (target === undefined || target.agent.displayLabel !== updateAdvisorPendingLabel(targetSha)) return false;
    return await this.tmux.label(target.socket, target.agent.paneId, updateAdvisorLabel(targetSha));
  }

  // reserve one agent for an idle restart
  async acquireRestartLock(agentId: string, expectedMutationVersion?: number, expectedMutationGeneration?: number): Promise<(() => void) | undefined> {
    const target = await this.discovery.target(agentId);
    // require a current target
    if (target === undefined) return undefined;
    const scope = this.historyScope(target.agent, agentId);
    // reject overlapping input and lifecycle work
    if (this.restartLocks.has(scope) || this.lockedAgentIds.has(agentId) || this.phases.has(scope) || (this.activeMutations.get(agentId) ?? 0) > 0
      || (expectedMutationVersion !== undefined && this.mutationVersion(agentId) !== expectedMutationVersion)
      || (expectedMutationGeneration !== undefined && this.mutationGeneration() !== expectedMutationGeneration)) return undefined;
    this.restartLocks.add(scope);
    this.lockedAgentIds.add(agentId);
    let released = false;
    // release the exact reservation once
    return () => {
      if (released) return;
      released = true;
      this.restartLocks.delete(scope);
      this.lockedAgentIds.delete(agentId);
    };
  }

  // reserve one direct agent mutation
  beginAgentMutation(agentId: string): (() => void) | undefined {
    // reject input after restart reservation
    if (this.lockedAgentIds.has(agentId)) return undefined;
    this.lifecycleMutationVersion += 1;
    this.mutationVersions.set(agentId, this.mutationVersion(agentId) + 1);
    this.activeMutations.set(agentId, (this.activeMutations.get(agentId) ?? 0) + 1);
    let released = false;
    // release the exact mutation once
    return () => {
      if (released) return;
      released = true;
      const remaining = (this.activeMutations.get(agentId) ?? 1) - 1;
      // remove empty counters
      if (remaining <= 0) this.activeMutations.delete(agentId);
      else this.activeMutations.set(agentId, remaining);
    };
  }

  // snapshot one agent mutation generation
  mutationVersion(agentId: string): number {
    return this.mutationVersions.get(agentId) ?? 0;
  }

  // snapshot all agent mutations
  mutationGeneration(): number {
    return this.lifecycleMutationVersion;
  }

  async listQueued(agentId: string): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.list(this.historyScope(target.agent, agentId));
  }

  async updateQueued(agentId: string, promptId: string, text: string): Promise<QueuedPromptSummary | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.update(this.historyScope(target.agent, agentId), promptId, text);
  }

  async moveQueued(agentId: string, promptId: string, direction: 'earlier' | 'later'): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.move(this.historyScope(target.agent, agentId), promptId, direction);
  }

  async removeQueued(agentId: string, promptId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    return target !== undefined && this.queued !== undefined && await this.queued.remove(this.historyScope(target.agent, agentId), promptId) !== undefined;
  }

  // advance managed prompt completion
  async observe(agent: Pick<Agent, 'id' | 'displayLabel' | 'workspace' | 'attention' | 'kind'>): Promise<void> {
    const scope = this.historyScope(agent, agent.id);
    // pause queue dispatch during restart handoffs
    if (this.restartLocks.has(scope)) return;
    // an Adapter without Turn capture cannot read an answer back: complete on
    // working -> finished, store the prompt alone, and skip the grace/halt path
    const adapter = this.resolveAdapter(agent.kind);
    if (adapter !== undefined && adapter.turns === undefined) return this.observeTurnless(agent, scope, reportsOwnState(adapter));
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry failed queue transfers without dispatching
    if (phase?.state === 'halted') {
      if (!busy && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    // wait through active agent work
    if (busy) {
      this.observedWorking.add(scope);
      this.reconciled.delete(scope);
      this.reconciliationPendingSince.delete(scope);
      // mark the prompt as started
      if (phase?.state === 'awaiting-start' || phase?.state === 'awaiting-answer') {
        const baselineCompletion = phase.baselineCompletion ?? await this.completionSignature(agent.id);
        this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }) });
      }
      // adopt externally started work once prompts are queued
      if (phase === undefined && (await this.queued?.list(scope))?.length) {
        const baselineCompletion = await this.completionSignature(agent.id);
        this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }) });
      }
      return;
    }
    // finish tracked work before releasing its queue
    if (phase !== undefined) {
      const completion = await this.recordAnswer(agent.id, scope, phase.historyEntryId, phase.historyPrompt, phase.baselineCompletion, phase.state !== 'awaiting-start');
      // allow terminal output to finish rendering
      if (completion === 'pending' && phase.state === 'working') {
        this.phases.set(scope, { ...phase, state: 'awaiting-answer', changedAt: Date.now() });
        return;
      }
      // retry capture and persistence during the grace window
      if (completion === 'pending' && Date.now() - phase.changedAt < answerCaptureGraceMs) return;
      // save the queue after failed, cancelled, or unrecordable work
      if (completion !== 'completed') {
        this.phases.set(scope, { state: 'halted', changedAt: Date.now() });
        // clear the halt after every queued prompt is durable
        if (await this.saveQueued(scope)) this.phases.delete(scope);
        return;
      }
      // reconcile adopted work before releasing its queue
      if (phase.historyEntryId === undefined) {
        // wait for restart recovery before releasing queued work
        if (!await this.reconciliationComplete(agent.id, scope)) return;
      }
      // release completed prompts
      this.phases.delete(scope);
    }
    // recover answer tracking lost across restarts
    if (phase === undefined && !this.reconciled.has(scope) && !await this.reconciliationComplete(agent.id, scope)) return;
    await this.dispatch(agent.id, scope);
  }

  // advance a Turn-less prompt: no answer to capture, so completion is the
  // working -> finished transition and the durable queue is released on finished
  private async observeTurnless(agent: Pick<Agent, 'id' | 'attention'>, scope: string, reported: boolean): Promise<void> {
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry a failed queue transfer without dispatching
    if (phase?.state === 'halted') {
      if (!busy && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    if (busy) {
      // the working report the reported-state machine was waiting for
      if (phase?.state === 'awaiting-start') this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now() });
      // adopt externally started work once prompts are queued
      else if (phase === undefined && (await this.queued?.list(scope))?.length) this.phases.set(scope, { state: 'working', changedAt: Date.now() });
      return;
    }
    if (phase !== undefined) {
      // a reported-state Agent must report `working` before `finished` counts as
      // completion; a paste that landed in a trust or fork prompt never does, so
      // fail the dispatch once the window elapses rather than release its queue
      if (reported && phase.state === 'awaiting-start') {
        if (Date.now() - phase.changedAt < reportedWorkingGraceMs) return;
        this.phases.set(scope, { state: 'halted', changedAt: Date.now() });
        if (await this.saveQueued(scope)) this.phases.delete(scope);
        return;
      }
      // working -> finished: the prompt completed; its history entry stays answerless
      this.phases.delete(scope);
    }
    await this.dispatch(agent.id, scope);
  }

  // move queued prompts durably into saved prompts
  private async saveQueued(scope: string): Promise<boolean> {
    if (this.dispatching.has(scope) || this.queued === undefined || this.saved === undefined) return false;
    this.dispatching.add(scope);
    try {
      // preserve every prompt until its saved copy succeeds
      while (true) {
        const prompt = await this.queued.next(scope);
        if (prompt === undefined) return true;
        const result = await this.queued.consumeOnSuccess(scope, prompt.id, async queued => await this.saved!.save(this.savedScope(scope), queued.text, queued.attachments ?? []) !== undefined);
        if (result === 'failed') return false;
      }
    } catch {
      return false;
    } finally {
      this.dispatching.delete(scope);
    }
  }

  private async dispatch(agentId: string, scope: string): Promise<void> {
    if (this.dispatching.has(scope) || this.phases.has(scope) || this.restartLocks.has(scope)) return;
    this.dispatching.add(scope);
    try {
      const prompt = await this.queued?.next(scope);
      if (prompt !== undefined && await this.send(agentId, prompt.text, prompt.attachments ?? [])) {
        await this.queued?.remove(scope, prompt.id);
      }
    } finally { this.dispatching.delete(scope); }
  }

  // send one prompt to a stable pane
  private async send(agentId: string, prompt: string, attachments: PromptAttachment[], discovered?: DiscoveredTarget, submission: 'queue' | 'enter' | 'confirmed-enter' = 'queue'): Promise<boolean> {
    const first = discovered ?? await this.discovery.target(agentId);
    if (!first) return false;
    // the Adapter describes the paste text and the submit keys; the console pastes and sends them
    const adapter = this.resolveAdapter(first.agent.kind);
    if (adapter === undefined) return false;
    const scope = this.historyScope(first.agent, agentId);
    const workspace = this.workspaceFor(first.agent.workspace);
    const staged = await this.stageAttachments(workspace, attachments);
    if (staged === undefined) return false;
    const attachmentPrompt = staged.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${staged.map(path => `@${path}`).join('\n')}`;
    const shellMode = attachments.length === 0 && prompt.startsWith('!');
    const mode: SubmissionMode = shellMode ? 'shell' : 'prompt';
    const composed = adapter.submission.prepare(attachmentPrompt, mode);
    // the update advisor is submitted with Enter regardless of the Adapter's queue key
    const keys: TmuxKey[] = submission === 'enter' || submission === 'confirmed-enter' ? ['Enter'] : composed.keys;
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    // keep the server-owned prompt out of the startup shell
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorReady(agentId, first)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, composed.text)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    const second = await this.discovery.target(agentId);
    if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    // wait until the fresh advisor composer rendered the complete paste
    if (submission === 'confirmed-enter' && !await this.waitForUpdateAdvisorComposer(agentId, second, attachmentPrompt)) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    // hold the scope so a quick second submit queues behind this one, then let the
    // interactive paste settle in the composer before the submit key: a Tab that
    // races an unrendered composer is swallowed, so the prompt never starts and the
    // queued work behind it is later relocated to saved (the reported bug)
    const settle = submission === 'queue' && mode === 'prompt' && adapter.turns !== undefined && this.queued !== undefined;
    if (settle) {
      this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), historyPrompt: attachmentPrompt });
      await this.waitForComposerRender(second, attachmentPrompt);
    }
    let submitted = await this.tmux.sendKeys(second.socket, second.agent.paneId, keys);
    // confirm the server-owned prompt left the composer
    if (submitted && submission === 'confirmed-enter') submitted = await this.waitForUpdateAdvisorStart(agentId, second, attachmentPrompt);
    if (!submitted) {
      // release the scope held for the unsettled paste
      if (settle) this.phases.delete(scope);
      await this.removeStaged(workspace, staged);
    } else {
      // track the successful prompt
      const entry = await this.history?.record(scope, attachmentPrompt).catch(() => undefined);
      // monitor managed prompt completion
      if (this.queued !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), historyPrompt: attachmentPrompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }) });
    }
    return submitted;
  }

  // wait (briefly) for a pasted interactive prompt to render on the validated pane,
  // so the submit key is not swallowed by a composer that has not yet caught up
  private async waitForComposerRender(target: DiscoveredTarget, prompt: string): Promise<void> {
    // cannot observe the composer: submit best-effort
    if (typeof this.tmux.capture !== 'function') return;
    const normalized = normalizedPrompt(prompt);
    // match the visible tail because Codex scrolls long composers to the cursor
    const visibleSuffix = normalized.slice(-Math.min(64, normalized.length));
    // match Codex's exact long-paste placeholder
    const collapsedPaste = `[Pasted Content ${queueReadyPrompt(prompt).length} chars]`;
    for (let attempt = 0; attempt < composerRenderAttempts; attempt += 1) {
      const captured = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
      const composer = captured === undefined ? '' : normalizedTerminalText(captured);
      // submit once the paste (or its collapsed placeholder) has begun rendering
      if (composer.includes(visibleSuffix) || composer.includes(collapsedPaste)) return;
      await new Promise(resolve => setTimeout(resolve, composerRenderPollMs));
    }
  }

  // wait for one stable empty Codex composer before pasting
  private async waitForUpdateAdvisorReady(agentId: string, expected: DiscoveredTarget): Promise<boolean> {
    let readySince: number | undefined;
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      const plain = captured?.replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '');
      const ready = agentAttentionState(target.agent) === 'finished' && plain !== undefined && /(?:^|\n)›(?:\s|$)/u.test(plain);
      // retain only uninterrupted readiness
      if (!ready) readySince = undefined;
      else if (readySince === undefined) readySince = Date.now();
      else if (Date.now() - readySince >= updateAdvisorReadyStableMs) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // wait for one pasted advisor prompt to reach Codex
  private async waitForUpdateAdvisorComposer(agentId: string, expected: DiscoveredTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // match the visible tail because Codex scrolls long composers to the cursor
    const visibleSuffix = normalized.slice(-Math.min(96, normalized.length));
    // match Codex's exact long-paste placeholder
    const collapsedPaste = `[Pasted Content ${queueReadyPrompt(prompt).length} chars]`;
    // bound fresh-process startup
    for (let attempt = 0; attempt < updateAdvisorComposerAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during launch
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      // submit only after the pasted prompt begins rendering
      const composer = captured === undefined ? '' : normalizedTerminalText(captured);
      if (composer.includes(visibleSuffix) || composer.includes(collapsedPaste)) return true;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // confirm one advisor prompt actually started
  private async waitForUpdateAdvisorStart(agentId: string, expected: DiscoveredTarget, prompt: string): Promise<boolean> {
    const normalized = normalizedPrompt(prompt);
    // bound submission confirmation and retry dropped Enter keys
    for (let attempt = 0; attempt < updateAdvisorStartAttempts; attempt += 1) {
      const target = await this.discovery.target(agentId, true);
      // reject pane replacement during submission
      if (target === undefined || target.socket.fingerprint !== expected.socket.fingerprint || target.agent.paneId !== expected.agent.paneId || target.agent.displayLabel !== expected.agent.displayLabel) return false;
      // accept working, questioning, or already completed prompts
      if (agentAttentionState(target.agent) !== 'finished') return true;
      const captured = await this.tmux.capture(target.socket, target.agent.paneId);
      if (normalizedPrompt(lastPromptFromHistory(captured ?? '') ?? '') === normalized) return true;
      // retry only after Codex had time to process the first key
      if ((attempt === 9 || attempt === 24) && !await this.tmux.sendKeys(target.socket, target.agent.paneId, ['Enter'])) return false;
      await new Promise(resolve => setTimeout(resolve, updateAdvisorPollMs));
    }
    return false;
  }

  // restore the latest matching unanswered entry
  private async reconcileLatestAnswer(agentId: string, scope: string): Promise<PromptReconciliation> {
    // require prompt history
    if (this.history === undefined || typeof this.history.list !== 'function') return 'settled';
    let entries: Awaited<ReturnType<PromptHistoryService['list']>>;
    // contain history read failures
    try { entries = await this.history.list(scope); }
    catch { entries = undefined; }
    // retry failed history reads
    if (entries === undefined) return 'pending';
    const unanswered = entries.filter(candidate => candidate.answer === undefined);
    // stop when no response needs recovery
    if (unanswered.length === 0) return 'settled';
    const target = await this.discovery.target(agentId);
    // require a stable pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    // require terminal history
    if (capture === undefined) return 'pending';
    const turn = latestCompletedAssistantTurn(capture);
    // require a completed turn
    if (turn === undefined) return 'pending';
    const newest = entries[0];
    let entry: (typeof entries)[number] | undefined;
    // recover only observed work when its prompt text scrolled away
    if (turn.prompt === undefined) {
      entry = this.observedWorking.has(scope) && newest?.answer === undefined && !entries.some(candidate => candidate.answer === turn.text) ? newest : undefined;
    } else {
      const capturedPrompt = turn.prompt;
      entry = unanswered.find(candidate => normalizedPrompt(candidate.text) === normalizedPrompt(capturedPrompt));
    }
    // require an unanswered match
    if (entry === undefined) return 'settled';
    const recorded = await this.history.recordAnswer(scope, entry.id, turn.text).catch(() => undefined);
    return recorded === undefined ? 'pending' : 'recorded';
  }

  // retry restart recovery through the shared render grace window
  private async reconciliationComplete(agentId: string, scope: string): Promise<boolean> {
    const result = await this.reconcileLatestAnswer(agentId, scope);
    // wait briefly for terminal rendering or storage recovery
    if (result === 'pending') {
      const startedAt = this.reconciliationPendingSince.get(scope) ?? Date.now();
      this.reconciliationPendingSince.set(scope, startedAt);
      // retain queued work during the recovery window
      if (Date.now() - startedAt < answerCaptureGraceMs) return false;
    }
    this.reconciliationPendingSince.delete(scope);
    this.reconciled.add(scope);
    this.observedWorking.delete(scope);
    return true;
  }

  // capture and persist the final answer
  private async recordAnswer(agentId: string, scope: string, entryId: string | undefined, prompt: string | undefined, baselineCompletion: string | undefined, allowPromptless = false): Promise<PromptCompletion> {
    const target = await this.discovery.target(agentId);
    // require the original pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    const turn = capture === undefined ? undefined : latestCompletedAssistantTurn(capture);
    // require a completed response
    if (capture === undefined) return 'pending';
    // fail explicit terminal errors without waiting through the grace window
    if (failedTurnFromCapture(capture)) return 'failed';
    // wait for the latest completed response
    if (turn === undefined) return 'pending';
    const completion = this.completionSignatureFromCapture(capture);
    const promptMatches = prompt === undefined
      || turn.prompt !== undefined && normalizedPrompt(turn.prompt) === normalizedPrompt(prompt)
      || allowPromptless && turn.prompt === undefined && completion !== baselineCompletion;
    // reject stale pane completions
    if (!promptMatches) return 'pending';
    // reject completions that predate externally tracked work
    if (prompt === undefined && completion === baselineCompletion) return 'pending';
    // persist tracked answers when history is available
    if (this.history !== undefined && entryId !== undefined) {
      const stored = await this.history.recordAnswer(scope, entryId, turn.text).catch(() => undefined);
      // retry transient or missing-entry writes
      if (stored === undefined) return 'pending';
    }
    return 'completed';
  }

  // capture the latest completed turn identity
  private async completionSignature(agentId: string): Promise<string | undefined> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return undefined;
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    if (capture === undefined) return undefined;
    const completion = this.completionSignatureFromCapture(capture);
    if (completion !== undefined) return completion;
    // retain the completion hidden by current in-progress output
    const currentPrompt = capture.lastIndexOf('\n› ');
    return currentPrompt < 0 ? undefined : this.completionSignatureFromCapture(capture.slice(0, currentPrompt));
  }

  // identify a completion without retaining pane output
  private completionSignatureFromCapture(capture: string): string | undefined {
    const turn = latestCompletedAssistantTurn(capture);
    return turn === undefined ? undefined : `${turn.prompt ?? ''}\0${turn.text}`;
  }

  private workspaceFor(workspace: string): string {
    return configuredWorktreeForWorkspace(this.worktrees, workspace)?.identity ?? workspace;
  }

  private historyScope(agent: Pick<Agent, 'displayLabel' | 'workspace'>, agentId: string): string {
    // prevent advisor prompts and feedback from entering the repository queue
    if (isUpdateAdvisorLabel(agent.displayLabel)) return `agent:${agentId}`;
    const worktree = configuredWorktreeForWorkspace(this.worktrees, agent.workspace);
    return worktree === undefined ? `agent:${agentId}` : `worktree:${worktree.id}`;
  }

  // map scratch queue scopes to saved prompt keys
  private savedScope(scope: string): string {
    return scope.startsWith('agent:') ? scope.slice('agent:'.length) : scope;
  }

  // keep staged attachments outside Git status
  private async ensureAttachmentRootIgnored(workspace: string, relativeRoot: string): Promise<boolean> {
    const ignored = await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot]);
    // retain repository ignore rules
    if (ignored.code === 0) return true;
    const resolved = await run('/usr/bin/git', ['-C', workspace, 'rev-parse', '--git-path', 'info/exclude']);
    // require a repository-local exclude file
    if (resolved.code !== 0 || resolved.stdout.trim() === '') return false;
    const excludePath = resolved.stdout.trim();
    const absoluteExcludePath = isAbsolute(excludePath) ? excludePath : join(workspace, excludePath);
    const existing = await readFile(absoluteExcludePath, 'utf8').catch(() => '');
    // add the narrow staging rule once
    if (!existing.split(/\r?\n/u).includes(attachmentIgnoreRule)) {
      await mkdir(dirname(absoluteExcludePath), { recursive: true });
      await appendFile(absoluteExcludePath, `${existing && !existing.endsWith('\n') ? '\n' : ''}${attachmentIgnoreRule}\n`, { mode: 0o600 });
    }
    return (await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot])).code === 0;
  }

  private async stageAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
    // skip empty attachment sets
    if (attachments.length === 0) return [];
    const files: Array<{ name: string; data: Buffer }> = [];
    let total = 0;
    // validate attachment payloads
    for (const attachment of attachments) {
      const name = promptAttachmentName(attachment.name);
      const data = promptAttachmentData(attachment.data);
      // reject unsafe or duplicate files
      if (!name || !data || files.some(file => file.name === name)) return undefined;
      total += data.length;
      // enforce the request limit
      if (total > maxPromptAttachmentBytes) return undefined;
      files.push({ name, data });
    }
    // stage beneath a dependency path
    const relativeRoot = `node_modules/.remote-agent-console/attachments/${randomBytes(12).toString('base64url')}`;
    // configure a local fallback for repositories without dependency ignores
    if (!await this.ensureAttachmentRootIgnored(workspace, relativeRoot)) return undefined;
    const root = join(workspace, relativeRoot);
    try {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await Promise.all(files.map(file => writeFile(join(root, file.name), file.data, { mode: 0o600 })));
      return files.map(file => `${relativeRoot}/${file.name}`);
    } catch {
      await rm(root, { recursive: true, force: true });
      return undefined;
    }
  }

  private async removeStaged(workspace: string, paths: string[]): Promise<void> {
    const relativeRoot = paths[0]?.split('/').slice(0, -1).join('/');
    if (relativeRoot) await rm(join(workspace, relativeRoot), { recursive: true, force: true });
  }


  async answerOption(agentId: string, index: number): Promise<boolean> {
    if (!Number.isInteger(index) || index < 0 || index > 15) return false;
    const first = await this.discovery.target(agentId); if (!first) return false;
    const adapter = this.resolveAdapter(first.agent.kind); if (adapter === undefined) return false;
    const second = await this.discovery.target(agentId); if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) return false;
    return await this.tmux.sendKeys(second.socket, second.agent.paneId, adapter.submission.selectOption(index));
  }
  async answerOmxQuestion(agentId: string, questionId: string, index: number): Promise<boolean> {
    if (!/^question-[A-Za-z0-9_.-]+$/.test(questionId) || !Number.isInteger(index) || index < 0 || index > 15) return false;
    const target = await this.discovery.target(agentId); if (!target) return false;
    const adapter = this.resolveAdapter(target.agent.kind); if (adapter === undefined) return false;
    const workspace = this.worktrees.find(worktree => target.agent.workspace === worktree.identity || target.agent.workspace === worktree.hostPath)?.identity ?? target.agent.workspace;
    const question = await omxQuestion(workspace, target.agent.paneId); if (!question || question.id !== questionId || index >= question.choices.length) return false;
    return await this.tmux.sendKeys(target.socket, question.paneId, adapter.submission.selectOption(index));
  }

  // interrupt a working Agent; a stray interrupt on a finished pane is refused so
  // it can never send a chord that exits the agent or opens a Rewind dialog
  async cancel(agentId: string): Promise<CancelOutcome> {
    const target = await this.discovery.target(agentId);
    if (target === undefined) return 'unavailable';
    const adapter = this.resolveAdapter(target.agent.kind);
    if (adapter === undefined) return 'unavailable';
    // the interrupt is sent only while the Agent is working or a question is pending
    if (agentAttentionState(target.agent) === 'finished') return 'not-working';
    if (!await this.tmux.sendKeys(target.socket, target.agent.paneId, adapter.submission.interrupt)) return 'unavailable';
    // a reported-state Agent fires no Stop hook on an interrupt; write `finished`
    // ourselves so the pane does not keep looking busy (Codex's title already stops)
    if (reportsOwnState(adapter)) await this.tmux.setReportedAttention(target.socket, target.agent.paneId, 'finished').catch(() => false);
    // record the in-flight prompt as interrupted: hold its queue rather than releasing it
    if (this.queued !== undefined) this.phases.set(this.historyScope(target.agent, agentId), { state: 'halted', changedAt: Date.now() });
    return 'ok';
  }
  async close(agentId: string): Promise<boolean> { const target = await this.discovery.target(agentId); return target !== undefined && this.tmux.close(target.socket, target.agent.paneId); }
}
