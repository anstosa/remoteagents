import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instanceIconNames, instanceIconSvg } from '../src/instance-icon.js';

// group shared artwork checks
describe('instance icon artwork', () => {
  // verify every host icon shares the display texture
  it.each(instanceIconNames)('renders scan lines behind the %s ornament', icon => {
    const svg = instanceIconSvg(icon);
    const scanLines = svg.indexOf('stroke-opacity=".42"');
    const ornament = svg.indexOf(icon === 'terminal' ? '<circle' : icon === 'potato' ? '<g>' : '<path d="M40 40');

    expect(scanLines).toBeGreaterThan(-1);
    expect(scanLines).toBeLessThan(ornament);
  });

  // preserve the favicon silhouette after PWA installation
  it('publishes the rounded icon without adaptive masking', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8')) as { icons?: Array<{ src?: string; purpose?: string }> };

    expect(manifest.icons).toContainEqual(expect.objectContaining({ src: '/favicon.svg', purpose: 'any' }));
    expect(manifest.icons?.some(icon => icon.purpose?.split(/\s+/u).includes('maskable'))).toBe(false);
  });
});
