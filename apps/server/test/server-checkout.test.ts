import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { serverCheckout, serverCheckoutOnHost } from '../src/workspaces/server-checkout.js';
import { testProject } from './helpers/config.js';

const previousServerCheckout = process.env.RAC_SERVER_CHECKOUT;

afterEach(() => {
  // restore the server checkout override
  if (previousServerCheckout === undefined) delete process.env.RAC_SERVER_CHECKOUT;
  else process.env.RAC_SERVER_CHECKOUT = previousServerCheckout;
});

describe('the server\'s own checkout', () => {
  it('resolves the repository root this server runs from', () => {
    delete process.env.RAC_SERVER_CHECKOUT;
    const repoRoot = realpathSync(fileURLToPath(new URL('../../..', import.meta.url)));
    expect(serverCheckout()).toBe(repoRoot);
  });

  it('honours RAC_SERVER_CHECKOUT when the process does not run from a checkout (the packaged image)', async () => {
    const mount = await mkdtemp(join(tmpdir(), 'rac-mount-'));
    try {
      process.env.RAC_SERVER_CHECKOUT = mount;
      expect(serverCheckout()).toBe(realpathSync(mount));
      // a blank override is no override
      process.env.RAC_SERVER_CHECKOUT = '   ';
      expect(serverCheckout()).toBe(realpathSync(fileURLToPath(new URL('../../..', import.meta.url))));
    } finally {
      await rm(mount, { recursive: true, force: true });
    }
  });

  it('prefers the explicit host override over any configured Project', () => {
    const projects = [testProject({ path: '/srv/console', hostPath: '/home/ubuntu/console' })];
    expect(serverCheckoutOnHost(projects, '/host/override', '/srv/console')).toBe('/host/override');
    // a blank override is no override
    expect(serverCheckoutOnHost(projects, '   ', '/srv/console')).toBe('/home/ubuntu/console');
  });

  it('maps the checkout through the Project declared at it: hostPath when mounted from the host, else its own path', () => {
    const bridged = [testProject({ path: '/srv/console', hostPath: '/home/ubuntu/console' })];
    expect(serverCheckoutOnHost(bridged, undefined, '/srv/console')).toBe('/home/ubuntu/console');
    const local = [testProject({ path: '/srv/console' })];
    expect(serverCheckoutOnHost(local, undefined, '/srv/console')).toBe('/srv/console');
  });

  it('resolves nothing when no Project declares the server\'s own checkout', () => {
    expect(serverCheckoutOnHost([testProject({ path: '/srv/other' })], undefined, '/srv/console')).toBeUndefined();
    expect(serverCheckoutOnHost([], undefined, '/srv/console')).toBeUndefined();
  });
});
