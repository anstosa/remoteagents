import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { omxQuestion } from '../discovery/service.js';
import type { Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';
import type { PromptHistoryService } from '../prompt-history/service.js';
import { agentAttentionState } from '../notifications.js';
import { QueuedPromptService, type QueuedPromptSummary } from './queue.js';
import { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentData, promptAttachmentName, validPrompt, validPromptAttachments, type PromptAttachment } from './validation.js';
export { maxPromptAttachmentBytes, maxPromptAttachments, promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from './validation.js';

/**
 * Tab is Codex's queue key.  Its completion menu owns Tab while the composer
 * ends in a token, though, so the prompt never reaches the queue.  A trailing
 * space dismisses that menu without changing the submitted prompt's meaning.
 */
const queueReadyPrompt = (prompt: string) => /\s$/u.test(prompt) ? prompt : `${prompt} `;
export class PromptService {
  private readonly phases = new Map<string, { state: 'awaiting-start' | 'working'; changedAt: number }>();
  private readonly dispatching = new Set<string>();

  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly worktrees: Worktree[] = [], private readonly history?: PromptHistoryService, private readonly queued?: QueuedPromptService) {}

  async submit(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    if (!validPrompt(prompt, attachments)) return false;
    const first = await this.discovery.target(agentId);
    if (!first) return false;
    const scope = this.historyScope(first.agent.workspace, agentId);
    const waiting = await this.queued?.list(scope);
    if (this.queued !== undefined && (agentAttentionState(first.agent) !== 'finished' || this.phases.has(scope) || (waiting?.length ?? 0) > 0)) return await this.queued.enqueue(scope, prompt, attachments) !== undefined;
    return await this.send(agentId, prompt, attachments);
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

  async observe(agent: Parameters<typeof agentAttentionState>[0]): Promise<void> {
    const scope = this.historyScope(agent.workspace, agent.id);
    const busy = agentAttentionState(agent) !== 'finished';
    const phase = this.phases.get(scope);
    if (busy) {
      if (phase?.state === 'awaiting-start') this.phases.set(scope, { state: 'working', changedAt: Date.now() });
      return;
    }
    if (phase?.state === 'working' || phase?.state === 'awaiting-start' && Date.now() - phase.changedAt >= 10_000) this.phases.delete(scope);
    else if (phase !== undefined) return;
    await this.dispatch(agent.id, scope);
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

  private async send(agentId: string, prompt: string, attachments: PromptAttachment[]): Promise<boolean> {
    const first = await this.discovery.target(agentId);
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
      if (this.queued !== undefined) this.phases.set(scope, { state: 'awaiting-start', changedAt: Date.now() });
      await this.history?.record(scope, attachmentPrompt).catch(() => undefined);
    }
    return submitted;
  }

  private workspaceFor(workspace: string): string {
    return this.worktrees.find(worktree => workspace === worktree.identity || workspace === worktree.hostPath)?.identity ?? workspace;
  }

  private historyScope(workspace: string, agentId: string): string {
    const worktree = this.worktrees.find(candidate => workspace === candidate.identity || workspace === candidate.hostPath);
    return worktree === undefined ? `agent:${agentId}` : `worktree:${worktree.id}`;
  }

  private async stageAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
    if (attachments.length === 0) return [];
    const files: Array<{ name: string; data: Buffer }> = [];
    let total = 0;
    for (const attachment of attachments) {
      const name = promptAttachmentName(attachment.name);
      const data = promptAttachmentData(attachment.data);
      if (!name || !data || files.some(file => file.name === name)) return undefined;
      total += data.length;
      if (total > maxPromptAttachmentBytes) return undefined;
      files.push({ name, data });
    }
    // node_modules is ignored by the configured repositories. Verify that
    // before writing, so attachments never make a worktree appear dirty.
    const relativeRoot = `node_modules/.remote-agent-console/attachments/${randomBytes(12).toString('base64url')}`;
    const ignored = await run('/usr/bin/git', ['-C', workspace, 'check-ignore', '--quiet', '--', relativeRoot]);
    if (ignored.code !== 0) return undefined;
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

  async cancel(agentId: string): Promise<boolean> { const target = await this.discovery.target(agentId); return target !== undefined && this.tmux.interrupt(target.socket, target.agent.paneId); }
  async close(agentId: string): Promise<boolean> { const target = await this.discovery.target(agentId); return target !== undefined && this.tmux.close(target.socket, target.agent.paneId); }
}
