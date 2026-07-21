import { randomBytes } from 'node:crypto';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
import { omxQuestion } from '../discovery/service.js';
import type { Worktree } from '../domain/models.js';
export class PromptService {
  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter, private readonly worktrees: Worktree[] = []) {}
  async submit(agentId: string, prompt: string): Promise<boolean> { if (!prompt || prompt.length > 32_000 || prompt.includes('\0')) return false; const first = await this.discovery.target(agentId); if (!first) return false; const buffer = `rac-${randomBytes(18).toString('base64url')}`; if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, prompt)) return false; const second = await this.discovery.target(agentId); if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) return false; return this.tmux.enter(second.socket, second.agent.paneId); }
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
