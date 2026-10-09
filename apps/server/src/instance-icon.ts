import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const instanceIconNames = ['terminal', 'potato', 'heart'] as const;
export type InstanceIcon = typeof instanceIconNames[number];

// texture the shared display background
const scanLines = '<path d="M6 11.5h52M6 16.5h52M6 21.5h52M6 26.5h52M6 31.5h52M6 36.5h52M6 41.5h52M6 46.5h52M6 51.5h52M6 56.5h52" fill="none" stroke="#45475a" stroke-width="1" stroke-opacity=".42"/>';

// recognize one supported icon alias
export function isInstanceIcon(value: string): value is InstanceIcon {
  return instanceIconNames.includes(value as InstanceIcon);
}

// render the portable terminal fallback
export function instanceIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="7.4" fill="#181825"/><rect x=".75" y=".75" width="62.5" height="62.5" rx="6.65" fill="none" stroke="#45475a" stroke-width="1.5"/>${scanLines}<circle cx="45" cy="20" r="5" fill="#89b4fa"/><path d="m11 40 6 5-6 5" fill="none" stroke="#cba6f7" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 51h9" fill="none" stroke="#89b4fa" stroke-width="3.5" stroke-linecap="round"/></svg>`;
}

// load trusted server-local artwork beside the configuration
export async function loadInstanceIconSvg(icon: InstanceIcon = 'terminal', configPath: string | undefined = process.env.RAC_CONFIG): Promise<string> {
  // keep the terminal fallback independent of local files
  if (icon === 'terminal' || configPath === undefined) return instanceIconSvg();
  try {
    return await readFile(join(dirname(configPath), 'instance-icons', `${icon}.svg`), 'utf8');
  } catch (error) {
    // preserve diagnostics without exposing local paths
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('icon unavailable', { cause: error });
    return instanceIconSvg();
  }
}
