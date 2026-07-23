import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { omxQuestion } from '../discovery/service.js';
import type { Worktree } from '../domain/models.js';
import { run } from '../tmux/command.js';

export const maxPromptAttachmentBytes = 8 * 1024 * 1024;
export const maxPromptAttachments = 10;
export type PromptAttachment = { name: string; data: string };

/**
 * Tab is Codex's queue key.  Its completion menu owns Tab while the composer
 * ends in a token, though, so the prompt never reaches the queue.  A trailing
 * space dismisses that menu without changing the submitted prompt's meaning.
 */
const queueReadyPrompt = (prompt: string) => /\s$/u.test(prompt) ? prompt : `${prompt} `;
const attachmentName = (value: string): string | undefined => {
  const name = value.trim();
  return name && name.length <= 240 && !/[\\/\0\r\n]/u.test(name) ? name : undefined;
};
const attachmentData = (value: string): Buffer | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value ? decoded : undefined;
};

export class PromptService {
  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly worktrees: Worktree[] = []) {}
  async submit(agentId: string, prompt: string, attachments: PromptAttachment[] = []): Promise<boolean> {
    if ((!prompt && attachments.length === 0) || prompt.length > 32_000 || prompt.includes('\0') || attachments.length > maxPromptAttachments) return false;
    const first = await this.discovery.target(agentId);
    if (!first) return false;
    const staged = await this.stageAttachments(first.agent.workspace, attachments);
    if (staged === undefined) return false;
    const attachmentPrompt = staged.length === 0 ? prompt : `${prompt}${prompt ? '\n\n' : ''}Attached files:\n${staged.map(path => `@${path}`).join('\n')}`;
    const buffer = `rac-${randomBytes(18).toString('base64url')}`;
    if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, queueReadyPrompt(attachmentPrompt))) {
      await this.removeStaged(first.agent.workspace, staged);
      return false;
    }
    const second = await this.discovery.target(agentId);
    if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) {
      await this.removeStaged(first.agent.workspace, staged);
      return false;
    }
    const queued = await this.tmux.queue(second.socket, second.agent.paneId);
    if (!queued) await this.removeStaged(first.agent.workspace, staged);
    return queued;
  }

  private async stageAttachments(workspace: string, attachments: PromptAttachment[]): Promise<string[] | undefined> {
    if (attachments.length === 0) return [];
    const files: Array<{ name: string; data: Buffer }> = [];
    let total = 0;
    for (const attachment of attachments) {
      const name = attachmentName(attachment.name);
      const data = attachmentData(attachment.data);
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
