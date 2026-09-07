import { open } from 'node:fs/promises';

/**
 * Bounded JSONL reads shared by the Claude and Codex conversation readers, so neither
 * loads a long transcript or rollout into memory. `readFileHead` returns the first
 * `maxBytes` as raw lines, dropping a trailing partial record when the file is longer;
 * `readFileTail` returns the last `maxBytes`, dropping a leading partial record when the
 * read did not start at the file head. Both tolerate a UTF-8 boundary split mid-record —
 * the caller parses each line and skips what does not parse.
 */

// the bounded head of a file as raw lines, dropping a trailing partial record
export async function readFileHead(path: string, maxBytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // a file longer than the window ends mid-record; drop the partial tail line
    if (size > length) lines.pop();
    return lines;
  } finally {
    await handle.close();
  }
}

// the bounded tail of a file as raw lines, dropping a partial leading record
export async function readFileTail(path: string, maxBytes: number): Promise<string[]> {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const offset = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
    // discard a partial leading record when the read did not start at the file head
    if (offset > 0) lines.shift();
    return lines;
  } finally {
    await handle.close();
  }
}
