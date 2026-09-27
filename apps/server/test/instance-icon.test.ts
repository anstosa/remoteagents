import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { instanceIconNames, instanceIconSvg } from '../src/instance-icon.js';

// group shared artwork checks
describe('instance icon artwork', () => {
  // verify every host icon shares the display texture
  it.each(instanceIconNames)('renders scan lines behind the %s ornament', icon => {
    const svg = instanceIconSvg(icon);
    const scanLines = svg.indexOf('stroke-opacity=".42"');
    const ornament = svg.indexOf(icon === 'terminal' ? '<circle' : icon === 'potato' ? '<g transform="translate(3 5) scale(.82)"' : '<g transform="translate(-1 6) scale(.82)"');

    expect(scanLines).toBeGreaterThan(-1);
    expect(scanLines).toBeLessThan(ornament);
  });

  // fill the whole button-sized icon without an inset frame
  it.each(instanceIconNames)('keeps the %s frame flush with the button edge', icon => {
    const svg = instanceIconSvg(icon);
    expect(svg).toContain('<rect width="64" height="64" rx="7.4"');
    expect(svg).toContain('<rect x=".75" y=".75" width="62.5" height="62.5"');
    expect(svg).not.toContain('<rect x="5" y="5"');
  });

  // preserve the favicon silhouette after PWA installation
  it('publishes the rounded icon without adaptive masking', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../web/public/manifest.webmanifest', import.meta.url), 'utf8')) as { icons?: Array<{ src?: string; purpose?: string }> };

    expect(manifest.icons).toContainEqual(expect.objectContaining({ src: '/favicon.svg', purpose: 'any' }));
    expect(manifest.icons?.some(icon => icon.purpose?.split(/\s+/u).includes('maskable'))).toBe(false);
  });
});
