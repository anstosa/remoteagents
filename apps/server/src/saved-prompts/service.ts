import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type SavedPrompt = { id: string; text: string };
type StoredPrompts = Record<string, SavedPrompt[]>;

const maxSavedPromptsPerAgent = 50;
const maxSavedAgents = 500;
const validAgentId = (value: string) => value.length > 0 && value.length <= 240 && !value.includes('\0');
const validPrompt = (value: string) => value.trim().length > 0 && value.length <= 32_000 && !value.includes('\0');
const validSavedPrompt = (value: unknown): value is SavedPrompt => {
  if (value === null || typeof value !== 'object') return false;
  const prompt = value as { id?: unknown; text?: unknown };
  return typeof prompt.id === 'string' && /^[A-Za-z0-9_-]{12,64}$/u.test(prompt.id) && typeof prompt.text === 'string' && validPrompt(prompt.text);
};

export class SavedPromptService {
  private mutation = Promise.resolve();

  constructor(private readonly file = process.env.RAC_SAVED_PROMPTS_FILE ?? '.data/saved-prompts.json') {}

  async list(agentId: string): Promise<SavedPrompt[] | undefined> {
    if (!validAgentId(agentId)) return undefined;
    await this.mutation;
    return [...((await this.read())[agentId] ?? [])];
  }

  async save(agentId: string, text: string): Promise<SavedPrompt | undefined> {
    if (!validAgentId(agentId) || !validPrompt(text)) return undefined;
    return await this.mutate(async stored => {
      if (stored[agentId] === undefined && Object.keys(stored).length >= maxSavedAgents) delete stored[Object.keys(stored)[0]!];
      const prompt = { id: randomBytes(18).toString('base64url'), text };
      stored[agentId] = [prompt, ...(stored[agentId] ?? [])].slice(0, maxSavedPromptsPerAgent);
      return prompt;
    });
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

  private async mutate<T>(change: (stored: StoredPrompts) => T | Promise<T>): Promise<T> {
    const operation = this.mutation.then(async () => {
      const stored = await this.read();
      const result = await change(stored);
      await this.write(stored);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private async read(): Promise<StoredPrompts> {
    const raw = await readFile(this.file, 'utf8').then(value => JSON.parse(value) as unknown).catch(() => ({}));
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).flatMap(([agentId, prompts]) => validAgentId(agentId) && Array.isArray(prompts) ? [[agentId, prompts.filter(validSavedPrompt).slice(0, maxSavedPromptsPerAgent)]] : []));
  }

  private async write(value: StoredPrompts): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const next = `${this.file}.next`;
    await writeFile(next, JSON.stringify(value), { mode: 0o600 });
    await rename(next, this.file);
  }
}
