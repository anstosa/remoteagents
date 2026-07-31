import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceService } from '../src/auth/devices.js';

const firstSession = 'a'.repeat(43);
const secondSession = 'b'.repeat(43);

describe('device names', () => {
  it('persists trimmed names by signed device session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rac-device-names-'));
    const file = join(directory, 'device-names.json');
    try {
      const devices = new DeviceService(file);

      await expect(devices.get(firstSession)).resolves.toBeUndefined();
      await expect(devices.set(firstSession, '  Kitchen iPad  ')).resolves.toBe('Kitchen iPad');
      await expect(devices.set(secondSession, 'Studio Mac')).resolves.toBe('Studio Mac');
      await expect(new DeviceService(file).get(firstSession)).resolves.toBe('Kitchen iPad');
      await expect(new DeviceService(file).get(secondSession)).resolves.toBe('Studio Mac');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('rejects invalid sessions and non-visible names', async () => {
    const devices = new DeviceService(join(tmpdir(), `rac-device-names-${Date.now()}.json`));

    await expect(devices.set('short', 'Phone')).resolves.toBeUndefined();
    await expect(devices.set(firstSession, '   ')).resolves.toBeUndefined();
    await expect(devices.set(firstSession, 'bad\nname')).resolves.toBeUndefined();
    await expect(devices.set(firstSession, 'x'.repeat(65))).resolves.toBeUndefined();
  });
});
