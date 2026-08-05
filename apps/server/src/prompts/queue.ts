import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promptAttachmentBytes, validPrompt, validPromptAttachments, type PromptAttachment } from './validation.js';

export type QueuedPrompt = { id: string; text: string; createdAt: string; attachments?: PromptAttachment[] };
export type QueuedPromptSummary = { id: string; text: string; createdAt: string; attachments?: Array<{ name: string; size: number }> };
type StoredQueues = Record<string, QueuedPrompt[]>;

const maxScopes = 500;
const maxPromptsPerScope = 50;
const maxStoredTextLength = 10_000_000;
const maxStoredAttachmentBytes = 100 * 1024 * 1024;
const validScope = (value: string) => value.length > 0 && value.length <= 240 && !value.includes('\0');
const validId = (value: string) => /^[A-Za-z0-9_-]{12,64}$/u.test(value);
const parsePrompt = (value: unknown): QueuedPrompt | undefined => {
  if (value === null || typeof value !== 'object') return undefined;
  const prompt = value as { id?: unknown; text?: unknown; createdAt?: unknown; attachments?: unknown };
  if (typeof prompt.id !== 'string' || !validId(prompt.id) || typeof prompt.text !== 'string' || typeof prompt.createdAt !== 'string' || !Number.isFinite(Date.parse(prompt.createdAt))) return undefined;
  const rawAttachments = prompt.attachments ?? [];
  if (!Array.isArray(rawAttachments)) return undefined;
  const attachments = rawAttachments.filter((attachment): attachment is PromptAttachment => attachment !== null && typeof attachment === 'object' && typeof (attachment as { name?: unknown }).name === 'string' && typeof (attachment as { data?: unknown }).data === 'string');
  if (attachments.length !== rawAttachments.length || !validPrompt(prompt.text, attachments)) return undefined;
  return { id: prompt.id, text: prompt.text, createdAt: prompt.createdAt, ...(attachments.length === 0 ? {} : { attachments }) };
};
const summarize = (prompt: QueuedPrompt): QueuedPromptSummary => ({ id: prompt.id, text: prompt.text, createdAt: prompt.createdAt, ...(prompt.attachments === undefined ? {} : { attachments: prompt.attachments.map(attachment => ({ name: attachment.name, size: promptAttachmentBytes(attachment)! })) }) });
const totals = (stored: StoredQueues) => Object.values(stored).flat().reduce((value, prompt) => ({ text: value.text + prompt.text.length, attachments: value.attachments + (prompt.attachments ?? []).reduce((sum, attachment) => sum + (promptAttachmentBytes(attachment) ?? 0), 0) }), { text: 0, attachments: 0 });

export class QueuedPromptService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_QUEUED_PROMPTS_FILE ?? '.data/queued-prompts.json') {}

  async list(scope: string): Promise<QueuedPromptSummary[] | undefined> {
    if (!validScope(scope)) return undefined;
    await this.mutation;
    return ((await this.read())[scope] ?? []).map(summarize);
  }

  async enqueue(scope: string, text: string, attachments: PromptAttachment[] = []): Promise<QueuedPromptSummary | undefined> {
    if (!validScope(scope) || !validPrompt(text, attachments) || !validPromptAttachments(attachments)) return undefined;
    return await this.mutate(stored => {
      if (stored[scope] === undefined && Object.keys(stored).length >= maxScopes) return undefined;
      const queue = stored[scope] ?? [];
      if (queue.length >= maxPromptsPerScope) return undefined;
      const prompt: QueuedPrompt = { id: randomBytes(18).toString('base64url'), text, createdAt: new Date().toISOString(), ...(attachments.length === 0 ? {} : { attachments }) };
      queue.push(prompt);
      stored[scope] = queue;
      const size = totals(stored);
      if (size.text > maxStoredTextLength || size.attachments > maxStoredAttachmentBytes) {
        queue.pop();
        if (queue.length === 0) delete stored[scope];
        return undefined;
      }
      return summarize(prompt);
    });
  }

  async update(scope: string, id: string, text: string): Promise<QueuedPromptSummary | undefined> {
    if (!validScope(scope) || !validId(id) || typeof text !== 'string') return undefined;
    return await this.mutate(stored => {
      const prompt = stored[scope]?.find(candidate => candidate.id === id);
      if (prompt === undefined || !validPrompt(text, prompt.attachments ?? [])) return undefined;
      const previous = prompt.text;
      prompt.text = text;
      if (totals(stored).text > maxStoredTextLength) {
        prompt.text = previous;
        return undefined;
      }
      return summarize(prompt);
    });
  }

  async move(scope: string, id: string, direction: 'earlier' | 'later'): Promise<QueuedPromptSummary[] | undefined> {
    if (!validScope(scope) || !validId(id)) return undefined;
    return await this.mutate(stored => {
      const queue = stored[scope];
      if (queue === undefined) return undefined;
      const index = queue.findIndex(prompt => prompt.id === id);
      if (index < 0) return undefined;
      const next = direction === 'earlier' ? index - 1 : index + 1;
      if (next < 0 || next >= queue.length) return queue.map(summarize);
      [queue[index], queue[next]] = [queue[next]!, queue[index]!];
      return queue.map(summarize);
    });
  }

  async remove(scope: string, id: string): Promise<QueuedPrompt | undefined> {
    if (!validScope(scope) || !validId(id)) return undefined;
    return await this.mutate(stored => {
      const queue = stored[scope];
      if (queue === undefined) return undefined;
      const index = queue.findIndex(prompt => prompt.id === id);
      if (index < 0) return undefined;
      const [prompt] = queue.splice(index, 1);
      if (queue.length === 0) delete stored[scope];
      return prompt;
    });
  }

  async next(scope: string): Promise<QueuedPrompt | undefined> {
    if (!validScope(scope)) return undefined;
    await this.mutation;
    return (await this.read())[scope]?.[0];
  }

  private async mutate<T>(change: (stored: StoredQueues) => T | Promise<T>, shouldWrite: (result: T) => boolean = () => true): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = await change(stored);
      if (shouldWrite(result)) await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredQueues> {
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    });
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid queued prompts file');
    const stored: StoredQueues = {};
    for (const [scope, prompts] of Object.entries(raw)) {
      if (!validScope(scope) || !Array.isArray(prompts) || prompts.length > maxPromptsPerScope) throw new Error('invalid queued prompts file');
      const parsed = prompts.map(parsePrompt);
      if (parsed.some(prompt => prompt === undefined)) throw new Error('invalid queued prompts file');
      stored[scope] = parsed as QueuedPrompt[];
    }
    const size = totals(stored);
    if (Object.keys(stored).length > maxScopes || size.text > maxStoredTextLength || size.attachments > maxStoredAttachmentBytes) throw new Error('queued prompts file exceeds storage limits');
    return stored;
  }

  private async write(value: StoredQueues): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
