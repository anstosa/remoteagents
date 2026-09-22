import { maxNoteTitleLength } from './service.js';
import type { PromptAttachment } from '../prompts/validation.js';

// compose queued prompt note content with a bounded host-local title
export function promptNoteContent(worktreeName: string, at: Date, prompt: { text: string; attachments?: PromptAttachment[] }): { title: string; text: string; attachments?: PromptAttachment[] } {
  const hours = at.getHours();
  const time = `${hours % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
  const prefix = 'Queued prompt in ';
  const suffix = ` · ${time}`;
  const fallbackName = worktreeName.trim() || 'workspace';
  const boundedName = fallbackName.slice(0, maxNoteTitleLength - prefix.length - suffix.length);
  return { title: `${prefix}${boundedName}${suffix}`, text: prompt.text, ...(prompt.attachments === undefined ? {} : { attachments: prompt.attachments }) };
}
