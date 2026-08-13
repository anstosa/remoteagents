import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import { lastPromptFromHistory, latestCompletedAssistantMessage, TmuxAdapter } from '../tmux/adapter.js';
import { omxQuestion } from '../discovery/service.js';
import type { Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import type { SavedPromptService } from '../saved-prompts/service.js';
import { agentAttentionState } from '../notifications.js';
import { QueuedPromptService, type QueuedPromptSummary } from './queue.js';
import { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentData, promptAttachmentName, validPrompt, validPromptAttachments, type PromptAttachment } from './validation.js';
import { configuredWorktreeForWorkspace } from '../workspaces/resolver.js';
export { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';

/**
 * Tab is Codex's queue key.  Its completion menu owns Tab while the composer
 * ends in a token, though, so the prompt never reaches the queue.  A trailing
 * space dismisses that menu without changing the submitted prompt's meaning.
 */
const queueReadyPrompt = (prompt: string) => /\s$/u.test(prompt) ? prompt : `${prompt} `;
const answerCaptureGraceMs = 10_000;
const attachmentIgnoreRule = '/node_modules/.remote-agent-console/';
type PromptCompletion = 'completed' | 'failed' | 'pending';
type PromptPhase = { state: 'awaiting-start' | 'working' | 'awaiting-answer' | 'halted'; changedAt: number; historyEntryId?: string; historyPrompt?: string; baselineCompletion?: string };
export class PromptService {
  private readonly phases = new Map<string, PromptPhase>();
  private readonly dispatching = new Set<string>();

  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly worktrees: Worktree[] = [], private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService, private readonly saved?: SavedPromptService) {}

  // submit or durably queue one prompt
  async submit(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    if (!validPrompt(prompt, attachments)) return false;
    const first = await this.discovery.target(agentId);
    if (!first) return false;
    const scope = this.historyScope(first.agent.workspace, agentId);
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
  }

  async listQueued(agentId: string): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.list(this.historyScope(target.agent.workspace, agentId));
  }

  async updateQueued(agentId: string, promptId: string, text: string): Promise<QueuedPromptSummary | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.update(this.historyScope(target.agent.workspace, agentId), promptId, text);
  }

  async moveQueued(agentId: string, promptId: string, direction: 'earlier' | 'later'): Promise<QueuedPromptSummary[] | undefined> {
    const target = await this.discovery.target(agentId);
    return target === undefined || this.queued === undefined ? undefined : await this.queued.move(this.historyScope(target.agent.workspace, agentId), promptId, direction);
  }

  async removeQueued(agentId: string, promptId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    return target !== undefined && this.queued !== undefined && await this.queued.remove(this.historyScope(target.agent.workspace, agentId), promptId) !== undefined;
  }

  // advance managed prompt completion
  async observe(agent: Parameters<typeof agentAttentionState>[0]): Promise<void> {
    const scope = this.historyScope(agent.workspace, agent.id);
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    // retry failed queue transfers without dispatching
    if (phase?.state === 'halted') {
      if (!busy && await this.saveQueued(scope)) this.phases.delete(scope);
      return;
    }
    // wait through active agent work
    if (busy) {
      // mark the prompt as started
      if (phase?.state === 'awaiting-start' || phase?.state === 'awaiting-answer') this.phases.set(scope, { ...phase, state: 'working', changedAt: Date.now() });
      // adopt externally started work once prompts are queued
      if (phase === undefined && (await this.queued?.list(scope))?.length) {
        const baselineCompletion = await this.completionSignature(agent.id);
        this.phases.set(scope, { state: 'working', changedAt: Date.now(), ...(baselineCompletion === undefined ? {} : { baselineCompletion }) });
      }
      return;
    }
    // finish tracked work before releasing its queue
    if (phase !== undefined) {
      const completion = await this.recordAnswer(agent.id, scope, phase.historyEntryId, phase.historyPrompt, phase.baselineCompletion);
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
      // release completed prompts
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
    if (this.dispatching.has(scope) || this.phases.has(scope)) return;
    this.dispatching.add(scope);
    try {
      const prompt = await this.queued?.next(scope);
      if (prompt !== undefined && await this.send(agentId, prompt.text, prompt.attachments ?? [])) {
        await this.queued?.remove(scope, prompt.id);
      }
    } finally { this.dispatching.delete(scope); }
  }

  // send one prompt to a stable pane
  private async send(agentId: string, prompt: string, attachments: PromptAttachment[], discovered?: NonNullable<Awaited<ReturnType<DiscoveryService['target']>>>): Promise<boolean> {
    const first = discovered ?? await this.discovery.target(agentId);
    if (!first) return false;
    const scope = this.historyScope(first.agent.workspace, agentId);
    const workspace = this.workspaceFor(first.agent.workspace);
    const staged = await this.stageAttachments(workspace, attachments);
    if (staged === undefined) return false;
    const attachmentPrompt = staged.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${staged.map(path => `@${path}`).join('\n')}`;
    const shellMode = attachments.length === 0 && prompt.startsWith('!');
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, shellMode ? attachmentPrompt : queueReadyPrompt(attachmentPrompt))) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    const second = await this.discovery.target(agentId);
    if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) {
      await this.removeStaged(workspace, staged);
      return false;
    }
    // Codex queues regular prompts with Tab, while its `!` shell mode submits
    // with Enter. Tab only completes shell input and leaves the command open.
    const submitted = shellMode ? await this.tmux.enter(second.socket, second.agent.paneId) : await this.tmux.queue(second.socket, second.agent.paneId);
    if (!submitted) await this.removeStaged(workspace, staged);
    else {
      // track the successful prompt
      const entry = await this.history?.record(scope, attachmentPrompt).catch(() => undefined);
      // monitor managed prompt completion
      if (this.queued !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now(), historyPrompt: attachmentPrompt, ...(entry === undefined ? {} : { historyEntryId: entry.id }) });
    }
    return submitted;
  }

  // capture and persist the final answer
  private async recordAnswer(agentId: string, scope: string, entryId: string | undefined, prompt: string | undefined, baselineCompletion: string | undefined): Promise<PromptCompletion> {
    const target = await this.discovery.target(agentId);
    // require the original pane
    if (target === undefined) return 'pending';
    const capture = await this.tmux.capture(target.socket, target.agent.paneId).catch(() => undefined);
    const answer = capture === undefined ? undefined : latestCompletedAssistantMessage(capture)?.text;
    // require a completed response
    if (capture === undefined) return 'pending';
    // fail explicit terminal errors without waiting through the grace window
    if (this.failedTurnFromCapture(capture)) return 'failed';
    // wait for the latest completed response
    if (answer === undefined) return 'pending';
    const capturedPrompt = lastPromptFromHistory(capture);
    const promptMatches = prompt === undefined || capturedPrompt !== undefined && capturedPrompt.replace(/\s+/gu, ' ').trim() === prompt.replace(/\s+/gu, ' ').trim();
    // reject stale pane completions
    if (!promptMatches) return 'pending';
    const completion = this.completionSignatureFromCapture(capture);
    // reject completions that predate externally tracked work
    if (prompt === undefined && completion === baselineCompletion) return 'pending';
    // persist tracked answers when history is available
    if (this.history !== undefined && entryId !== undefined) {
      const stored = await this.history.recordAnswer(scope, entryId, answer).catch(() => undefined);
      // retry transient or missing-entry writes
      if (stored === undefined) return 'pending';
    }
    return 'completed';
  }

  // recognize explicit failure for the latest prompt turn
  private failedTurnFromCapture(capture: string): boolean {
    const latestPrompt = capture.lastIndexOf('\n› ');
    const latestTurn = latestPrompt < 0 ? capture : capture.slice(latestPrompt + 1);
    return /^\u25a0 (?:Request failed|Cancelled)\b/mu.test(latestTurn);
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
    const answer = latestCompletedAssistantMessage(capture)?.text;
    return answer === undefined ? undefined : `${lastPromptFromHistory(capture) ?? ''}\0${answer}`;
  }

  private workspaceFor(workspace: string): string {
    return configuredWorktreeForWorkspace(this.worktrees, workspace)?.identity ?? workspace;
  }

  private historyScope(workspace: string, agentId: string): string {
    const worktree = configuredWorktreeForWorkspace(this.worktrees, workspace);
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
    const second = await this.discovery.target(agentId); if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) return false;
    return await this.tmux.selectOption(second.socket, second.agent.paneId, index);
  }
  async answerOmxQuestion(agentId: string, questionId: string, index: number): Promise<boolean> {
    if (!/^question-[A-Za-z0-9_.-]+$/.test(questionId) || !Number.isInteger(index) || index < 0 || index > 15) return false;
    const target = await this.discovery.target(agentId); if (!target) return false;
    const workspace = this.worktrees.find(worktree => target.agent.workspace === worktree.identity || target.agent.workspace === worktree.hostPath)?.identity ?? target.agent.workspace;
    const question = await omxQuestion(workspace, target.agent.paneId); if (!question || question.id !== questionId || index >= question.choices.length) return false;
    return await this.tmux.selectOption(target.socket, question.paneId, index);
  }

  async cancel(agentId: string): Promise<boolean> {
    const target = await this.discovery.target(agentId);
    if (target === undefined || !await this.tmux.interrupt(target.socket, target.agent.paneId)) return false;
    // prevent cancellation from releasing queued prompts
    if (this.queued !== undefined) this.phases.set(this.historyScope(target.agent.workspace, agentId), { state: 'halted', changedAt: Date.now() });
    return true;
  }
  async close(agentId: string): Promise<boolean> { const target = await this.discovery.target(agentId); return target !== undefined && this.tmux.close(target.socket, target.agent.paneId); }
}
