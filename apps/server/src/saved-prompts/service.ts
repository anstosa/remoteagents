import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promptAttachmentBytes, validPromptAttachments, type PromptAttachment } from '../prompts/validation.js';

export type SavedPrompt = { id: string; text: string; attachments?: PromptAttachment[] };
export type SavedPromptSummary = { id: string; text: string; attachments?: Array<{ name: string; size: number }> };
type StoredPrompts = Record<string, SavedPrompt[]>;

const maxSavedPromptsPerAgent = 50;
const maxSavedAgents = 500;
const defaultStorageLimits = { text: 10_000_000, attachments: 100 * 1024 * 1024, attachmentsPerAgent: 50 * 1024 * 1024 };
const validAgentId = (value: string) => value.length > 0 && value.length <= 240 && !value.includes('\0');
const validPrompt = (value: string, attachments: PromptAttachment[]) => (value.trim().length > 0 || attachments.length > 0) && value.length <= 32_000 && !value.includes('\0');
const parseSavedPrompt = (value: unknown): SavedPrompt | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const prompt = value as { id?: unknown; text?: unknown; attachments?: unknown };
  if (typeof prompt.id !== 'string' || !/^[A-Za-z0-9_-]{12,64}$/u.test(prompt.id) || typeof prompt.text !== 'string') return undefined;
  const rawAttachments = prompt.attachments ?? [];
  if (!Array.isArray(rawAttachments)) return undefined;
  const attachments = rawAttachments.filter((attachment): attachment is PromptAttachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' && typeof (attachment as { data?: unknown }).data === 'string');
  if (attachments.length !== rawAttachments.length || !validPrompt(prompt.text, attachments) || !validPromptAttachments(attachments)) return undefined;
  return { id: prompt.id, text: prompt.text, ...(attachments.length === 0 ? {} : { attachments }) };
};
const summarize = (prompt: SavedPrompt): SavedPromptSummary => ({ id: prompt.id, text: prompt.text, ...(prompt.attachments === undefined ? {} : { attachments: prompt.attachments.map(attachment => ({ name: attachment.name, size: promptAttachmentBytes(attachment)! })) }) });
const storageTotals = (stored: StoredPrompts) => Object.entries(stored).reduce((totals, [agentId, prompts]) => {
  const attachments = prompts.reduce((sum, prompt) => sum + (prompt.attachments ?? []).reduce((attachmentSum, attachment) => attachmentSum + (promptAttachmentBytes(attachment) ?? 0), 0), 0);
  totals.text += prompts.reduce((sum, prompt) => sum + prompt.text.length, 0);
  totals.attachments += attachments;
  totals.attachmentsByAgent.set(agentId, attachments);
  return totals;
}, { text: 0, attachments: 0, attachmentsByAgent: new Map<string, number>() });

export class SavedPromptService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_SAVED_PROMPTS_FILE ?? '.data/saved-prompts.json', private readonly limits = defaultStorageLimits) {}

  async list(agentId: string): Promise<SavedPromptSummary[] | undefined> {
    if (!validAgentId(agentId)) return undefined;
    await this.mutation;
    return ((await this.read())[agentId] ?? []).map(summarize);
  }

  async save(agentId: string, text: string, attachments: PromptAttachment[] = []): Promise<SavedPromptSummary | undefined> {
    if (!validAgentId(agentId) || !validPrompt(text, attachments) || !validPromptAttachments(attachments)) return undefined;
    return await this.mutate(async stored => {
      const previous = stored[agentId];
      const evictedAgentId = previous === undefined && Object.keys(stored).length >= maxSavedAgents ? Object.keys(stored)[0] : undefined;
      const evictedPrompts = evictedAgentId === undefined ? undefined : stored[evictedAgentId];
      if (evictedAgentId !== undefined) delete stored[evictedAgentId];
      const prompt = { id: randomBytes(18).toString('base64url'), text, ...(attachments.length === 0 ? {} : { attachments }) };
      stored[agentId] = [prompt, ...(stored[agentId] ?? [])].slice(0, maxSavedPromptsPerAgent);
      if (!this.withinLimits(stored)) {
        if (previous === undefined) delete stored[agentId]; else stored[agentId] = previous;
        if (evictedAgentId !== undefined && evictedPrompts !== undefined) stored[evictedAgentId] = evictedPrompts;
        return undefined;
      }
      return summarize(prompt);
    });
  }

  async get(agentId: string, promptId: string): Promise<SavedPrompt | undefined> {
    if (!validAgentId(agentId) || !/^[A-Za-z0-9_-]{12,64}$/u.test(promptId)) return undefined;
    await this.mutation;
    return (await this.read())[agentId]?.find(prompt => prompt.id === promptId);
  }

  async consume(agentId: string, promptId: string): Promise<SavedPrompt | undefined> {
    if (!validAgentId(agentId) || !/^[A-Za-z0-9_-]{12,64}$/u.test(promptId)) return undefined;
    return await this.mutate(async stored => {
      const prompts = stored[agentId] ?? [];
      const index = prompts.findIndex(prompt => prompt.id === promptId);
      if (index < 0) return undefined;
      const [prompt] = prompts.splice(index, 1);
      if (prompts.length === 0) delete stored[agentId];
      return prompt;
    });
  }

  async consumeOnSuccess(agentId: string, promptId: string, use: (prompt: SavedPrompt) => Promise<boolean>): Promise<'missing' | 'failed' | 'consumed'> {
    if (!validAgentId(agentId) || !/^[A-Za-z0-9_-]{12,64}$/u.test(promptId)) return 'missing';
    return await this.mutate(async stored => {
      const prompts = stored[agentId] ?? [];
      const index = prompts.findIndex(prompt => prompt.id === promptId);
      if (index < 0) return 'missing';
      if (!await use(prompts[index]!)) return 'failed';
      prompts.splice(index, 1);
      if (prompts.length === 0) delete stored[agentId];
      return 'consumed';
    }, result => result === 'consumed');
  }

  // drop every saved prompt for one scope — Remove deletes the Worktree's saved prompts
  async clearScope(agentId: string): Promise<void> {
    if (!validAgentId(agentId)) return;
    await this.mutate(stored => { delete stored[agentId]; });
  }

  private async mutate<T>(change: (stored: StoredPrompts) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = await change(stored);
      if (shouldWrite(result)) await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredPrompts> {
    const maxFileBytes = Math.ceil(this.limits.attachments * 4 / 3) + this.limits.text * 3 + 5 * 1024 * 1024;
    const info = await stat(this.file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info !== undefined && info.size > maxFileBytes) throw new Error('saved prompts file exceeds storage limits');
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(() => ({}));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const stored = Object.fromEntries(Object.entries(raw).flatMap(([agentId, prompts]) => validAgentId(agentId) && Array.isArray(prompts) ? [[agentId, prompts.map(parseSavedPrompt).filter((prompt): prompt is SavedPrompt => prompt !== undefined).slice(0, maxSavedPromptsPerAgent)]] : []));
    if (!this.withinLimits(stored)) throw new Error('saved prompts file exceeds storage limits');
    return stored;
  }

  private withinLimits(stored: StoredPrompts) {
    const totals = storageTotals(stored);
    return totals.text <= this.limits.text && totals.attachments <= this.limits.attachments && [...totals.attachmentsByAgent.values()].every(bytes => bytes <= this.limits.attachmentsPerAgent);
  }

  private async write(value: StoredPrompts): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
