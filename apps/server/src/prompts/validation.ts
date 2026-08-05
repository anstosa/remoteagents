export const maxPromptAttachmentBytes = 25 * 1024 * 1024;
export const maxPromptAttachments = 10;
export type PromptAttachment = { name: string; data: string };

export const promptAttachmentData = (value: string): Buffer | undefined => {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value ? decoded : undefined;
};

export const promptAttachmentName = (value: string): string | undefined => {
  const name = value.trim();
  return name && name.length <= 240 && !/[\\/\0\r\n]/u.test(name) ? name : undefined;
};

export const promptAttachmentBytes = (attachment: PromptAttachment): number | undefined => promptAttachmentData(attachment.data)?.length;

export const validPromptAttachments = (attachments: PromptAttachment[]): boolean => {
  if (attachments.length > maxPromptAttachments) return false;
  const names = new Set<string>();
  let total = 0;
  for (const attachment of attachments) {
    const name = promptAttachmentName(attachment.name);
    const bytes = promptAttachmentBytes(attachment);
    if (name === undefined || bytes === undefined || names.has(name)) return false;
    names.add(name);
    total += bytes;
    if (total > maxPromptAttachmentBytes) return false;
  }
  return true;
};

export const validPrompt = (text: string, attachments: PromptAttachment[] = []) => (text.trim().length > 0 || attachments.length > 0) && text.length <= 32_000 && !text.includes('\0') && validPromptAttachments(attachments);
