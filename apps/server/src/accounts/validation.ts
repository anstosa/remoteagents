// restrict account ids before filesystem access or billing lookup
export const safeAccountId = /^[a-zA-Z0-9_-]{1,80}$/u;

// narrow one json object at account protocol boundaries
export function record(value: unknown): Record<string, unknown> | undefined {
  // reject arrays and null
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}
