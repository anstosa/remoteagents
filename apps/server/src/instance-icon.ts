export const instanceIconNames = ['terminal', 'potato', 'heart'] as const;
export type InstanceIcon = typeof instanceIconNames[number];

// define the optional instance badge
const ornaments: Record<InstanceIcon, string> = {
  terminal: '<circle cx="45" cy="20" r="5" fill="#89b4fa"/>',
  potato: '<g><path d="M19 32c-.5-5 2.5-9 5-11 2.5-1.5 3.5-1.7 4.1-2.1 2.6-1.4 4.3-4.7 7.9-7.1 4-2.7 9.4-3.1 12.7-1.3 3 1.6 6.1 5.2 5.2 12.4-.9 7.2-18.9 19-22 19.2C28.8 42.3 19.7 39.6 19 32Z" fill="#c68a52" stroke="#11111b" stroke-width="2.5" stroke-linejoin="round"/><path d="M20.5 34.4c4.4 5.7 9.2 5.8 13 4.5 6.7-2.3 15.8-8.1 20.1-14.3-2.2 7.3-18.7 17.3-22 17.5-4.1.2-9.7-2.8-11.1-7.7Z" fill="#875b52"/><path d="M23 29.5c1.1-4.2 4.9-5.8 8.2-7.3 4.2-1.9 5.5-7.7 10.3-9.4 2-.7 4.1-.2 4.8.8-4.9-.1-6.1 5.7-9.1 8.2-3.6 3-9.3 2.4-14.2 7.7Z" fill="#e6b978"/><circle cx="29" cy="34" r="1.5" fill="#704214"/><circle cx="40" cy="31" r="1.7" fill="#704214"/><circle cx="48" cy="18" r="1.4" fill="#704214"/><circle cx="34" cy="18" r="1.1" fill="#704214"/></g>',
  heart: '<path d="M40 40c-2.7-2.6-16-10.7-16-20.9 0-10 12.7-13 16-5.5 3.3-7.5 16-4.5 16 5.5C56 29.3 42.7 37.4 40 40Z" fill="#a6e3a1" stroke="#11111b" stroke-width="2.5" stroke-linejoin="round"/>'
};

// texture the shared display background
const scanLines = '<path d="M6 11.5h52M6 16.5h52M6 21.5h52M6 26.5h52M6 31.5h52M6 36.5h52M6 41.5h52M6 46.5h52M6 51.5h52M6 56.5h52" fill="none" stroke="#45475a" stroke-width="1" stroke-opacity=".42"/>';

// recognize one bundled icon name
export function isInstanceIcon(value: string): value is InstanceIcon {
  return instanceIconNames.includes(value as InstanceIcon);
}

// render one self-contained browser icon
export function instanceIconSvg(icon: InstanceIcon = 'terminal'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1e1e2e"/><rect x="5" y="5" width="54" height="54" rx="10" fill="#11111b" stroke="#45475a" stroke-width="2"/>${scanLines}${ornaments[icon]}<path d="m11 40 6 5-6 5" fill="none" stroke="#cba6f7" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M20 51h9" fill="none" stroke="#89b4fa" stroke-width="3.5" stroke-linecap="round"/></svg>`;
}
