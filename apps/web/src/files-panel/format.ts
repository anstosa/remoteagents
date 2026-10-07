// format raw byte counts without hiding exact metadata from assistive text
export function formatFileSize(bytes: number): string {
  // keep small objects in exact bytes
  if (bytes < 1_000) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = -1;
  // select the largest readable decimal unit
  while (value >= 1_000 && unit < units.length - 1) { value /= 1_000; unit += 1; }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

// format valid server timestamps in the current browser locale
export function formatModifiedAt(value: string): string {
  const date = new Date(value);
  // leave malformed values visible instead of inventing a date
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}
