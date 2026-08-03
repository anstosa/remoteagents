const terminalReset = '\x1b[0m';
const maxLiveSnapshotLength = 1_000_000;

export const retainedTextTail = (value: string, maxLength: number) => {
  if (value.length <= maxLength) return value;
  const containsTerminalControl = value.includes('\x1b') && maxLength > terminalReset.length;
  let start = value.length - (containsTerminalControl ? maxLength - terminalReset.length : maxLength);
  const first = value.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1;
  if (!containsTerminalControl) return value.slice(start);
  const lineStart = value.indexOf('\n', start);
  if (lineStart >= 0) start = lineStart + 1;
  else {
    const escapeStart = value.lastIndexOf('\x1b[', start);
    if (escapeStart >= 0) {
      const controlEnd = /[\x40-\x7e]/u.exec(value.slice(escapeStart + 2))?.index;
      if (controlEnd === undefined || escapeStart + 2 + controlEnd >= start) start = controlEnd === undefined ? start : escapeStart + 3 + controlEnd;
    }
  }
  return `${terminalReset}${value.slice(start)}`;
};

export const nextLiveSnapshot = (current: string, type: 'append' | 'reset', text: string) => type === 'reset'
  ? text
  : retainedTextTail(`${current}${text}`, maxLiveSnapshotLength);

export class BoundedTextCache {
  readonly #entries = new Map<string, string>();

  constructor(private readonly maxEntries: number, private readonly maxLength: number) {}

  get size() { return this.#entries.size; }

  has(key: string) { return this.#entries.has(key); }

  get(key: string) {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  set(key: string, value: string) {
    this.#entries.delete(key);
    this.#entries.set(key, retainedTextTail(value, this.maxLength));
    while (this.#entries.size > this.maxEntries) this.#entries.delete(this.#entries.keys().next().value!);
  }

  append(key: string, value: string) {
    this.set(key, `${this.#entries.get(key) ?? ''}${value}`);
  }

  retain(keys: ReadonlySet<string>) {
    for (const key of this.#entries.keys()) if (!keys.has(key)) this.#entries.delete(key);
  }
}
