import { randomBytes } from 'node:crypto';
import type { DiscoveryService } from '../discovery/service.js';
import { TmuxAdapter } from '../tmux/adapter.js';
export class PromptService {
  constructor(private readonly discovery: DiscoveryService, private readonly tmux: TmuxAdapter) {}
  async submit(agentId: string, prompt: string): Promise<boolean> { if (!prompt || prompt.length > 32_000 || prompt.includes('\0')) return false; const first = await this.discovery.target(agentId); if (!first) return false; const buffer = `rac-${randomBytes(18).toString('base64url')}`; if (!await this.tmux.pastePrompt(first.socket, first.agent.paneId, buffer, prompt)) return false; const second = await this.discovery.target(agentId); if (!second || second.socket.fingerprint !== first.socket.fingerprint || second.agent.paneId !== first.agent.paneId) return false; return this.tmux.enter(second.socket, second.agent.paneId); }
  async cancel(agentId: string): Promise<boolean> { const target = await this.discovery.target(agentId); return target !== undefined && this.tmux.interrupt(target.socket, target.agent.paneId); }
}
