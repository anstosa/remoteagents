import type { FileEntry } from './contracts.js';

type IconEntry = Pick<FileEntry, 'name' | 'kind' | 'symlinkTargetKind'>;
type FileIconName = 'folder' | 'file' | 'file-code' | 'json' | 'file-text' | 'file-pdf' | 'file-media' | 'file-zip' | 'file-binary' | 'file-symlink-directory' | 'file-symlink-file';

const extensionGroups: { icon: FileIconName; extensions: ReadonlySet<string> }[] = [
  { icon: 'file-code', extensions: new Set('js jsx mjs cjs ts tsx mts cts py pyw rb php go rs java c cc cpp cxx h hh hpp cs fs fsx swift kt kts scala vue svelte html htm css scss sass less sh bash zsh fish ps1 sql lua pl r ex exs erl hrl'.split(' ')) },
  { icon: 'json', extensions: new Set('json jsonc json5'.split(' ')) },
  { icon: 'file-text', extensions: new Set('txt md mdx markdown rst log csv tsv yaml yml toml ini cfg conf env'.split(' ')) },
  { icon: 'file-pdf', extensions: new Set(['pdf']) },
  { icon: 'file-media', extensions: new Set('png jpg jpeg gif svg webp avif ico bmp tiff tif mp3 wav ogg flac aac m4a mp4 webm mov avi mkv'.split(' ')) },
  { icon: 'file-zip', extensions: new Set('zip tar gz tgz bz2 xz zst 7z rar jar war'.split(' ')) },
  { icon: 'file-binary', extensions: new Set('bin exe dll so dylib o a wasm class pyc'.split(' ')) }
];
const codeNames = new Set(['dockerfile', 'containerfile', 'makefile', 'gnumakefile', '.bashrc', '.zshrc', '.profile']);
const textNames = /^(?:readme|license|licence|changelog|authors|notice|copying)(?:\.|$)/u;

// choose outline artwork without changing object type or activation semantics
export function fileIconName(entry: IconEntry): FileIconName {
  // preserve navigable folder identity before considering its extension
  if (entry.kind === 'directory') return 'folder';
  // distinguish links even when their target is missing or inaccessible
  if (entry.kind === 'symlink') return entry.symlinkTargetKind === 'directory' ? 'file-symlink-directory' : 'file-symlink-file';
  // keep devices and other nonregular objects visually distinct
  if (entry.kind !== 'file') return 'file-binary';
  const name = entry.name.toLowerCase();
  // recognize common extensionless project files
  if (codeNames.has(name)) return 'file-code';
  // identify documentation with or without a suffix
  if (textNames.test(name)) return 'file-text';
  // match supported suffixes while retaining a generic fallback
  const extension = name.includes('.') ? name.split('.').at(-1) ?? '' : '';
  return extensionGroups.find(group => group.extensions.has(extension))?.icon ?? 'file';
}

// tint self-hosted VS Code vectors to the surrounding outline icon color
export function FileIcon({ entry, decorative = false }: { entry: IconEntry; decorative?: boolean }) {
  const icon = fileIconName(entry);
  const mask = `url('/icons/codicons/${icon}.svg')`;
  return <span className="files-kind" data-icon={icon} role={decorative ? undefined : 'img'} aria-hidden={decorative ? true : undefined} aria-label={decorative ? undefined : entry.kind} title={decorative ? undefined : entry.kind} style={{ maskImage: mask, WebkitMaskImage: mask }} />;
}
