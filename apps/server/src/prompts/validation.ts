export const maxPromptAttachmentBytes = 25 * 1024 * 1024;
// bound durable json while allowing the encoded form of the decoded storage budget
export const maxStoredAttachmentFootprintBytes = 200 * 1024 * 1024;
export type PromptAttachment = { name: string; data: string };

// decode one bounded canonical base64 payload
export const promptAttachmentData = (value: string): Buffer | undefined => {
  const maxEncodedLength = Math.ceil(maxPromptAttachmentBytes / 3) * 4;
  // bound and shape-check before decoding
  if (value.length === 0 || value.length > maxEncodedLength || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return undefined;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length > 0 && decoded.toString('base64') === value ? decoded : undefined;
};

// canonicalize one safe staged filename
export const promptAttachmentName = (value: string): string | undefined => {
  const name = value.trim();
  return name && name !== '.' && name !== '..' && name.length <= 240 && !/[\\/\0\r\n]/u.test(name) ? name : undefined;
};

export const promptAttachmentBytes = (attachment: PromptAttachment): number | undefined => promptAttachmentData(attachment.data)?.length;

// measure the serialized bytes attributable to one stored attachment field
export const promptAttachmentsStorageFootprint = (attachments: PromptAttachment[]): number => attachments.length === 0 ? 0 : Buffer.byteLength(JSON.stringify({ attachments }), 'utf8');

// validate filenames, payloads, duplicate names and the shared byte limit
export const validPromptAttachments = (attachments: PromptAttachment[]): boolean => {
  const names = new Set<string>();
  let total = 0;
  // validate every attachment record
  for (const attachment of attachments) {
    const name = promptAttachmentName(attachment.name);
    const bytes = promptAttachmentBytes(attachment);
    // require one unique safe filename and canonical payload
    if (name === undefined || bytes === undefined || names.has(name)) return false;
    names.add(name);
    total += bytes;
    // preserve the aggregate request byte limit
    if (total > maxPromptAttachmentBytes) return false;
  }
  return true;
};

export const validPrompt = (text: string, attachments: PromptAttachment[] = []) => (text.trim().length > 0 || attachments.length > 0) && text.length <= 32_000 && !text.includes('\0') && validPromptAttachments(attachments);
