import { basename } from 'node:path';
import { claudeConfigDir, claudeConversationTitle, validClaudeSessionId } from './claude-conversations.js';
import { claudeSkillDirectories, claudeSlash } from './claude-commands.js';
import { claudeFiles, claudeHooksFileName } from './claude-hooks.js';
import type { Adapter, TmuxKey } from './types.js';

// The packaged CLI entry a `node …` invocation of Claude Code runs.
const claudeCliEntry = '@anthropic-ai/claude-code/cli.js';

/**
 * Recognise the Claude Code process itself, never a descendant. It presents as
 * `comm === 'claude'`, an argv[0] whose basename is `claude`, or `node` running the
 * packaged CLI (`…/@anthropic-ai/claude-code/cli.js`). A `bash -c` tool child of a
 * live session — or an `srt`/`bwrap` wrapper ancestor — must not match; the walker
 * owns ancestry, the Adapter classifies one process (ADR 0002).
 */
function recognizes({ comm, argv }: { comm: string; argv: string[] }): boolean {
  if (comm === 'claude') return true;
  const arg0 = argv[0];
  if (arg0 !== undefined && basename(arg0) === 'claude') return true;
  const isNode = comm === 'node' || (arg0 !== undefined && basename(arg0) === 'node');
  return isNode && argv.some(argument => argument.endsWith(claudeCliEntry));
}

// The operator arguments the Adapter composes itself (so a duplicate in
// `adapters.claude.args` is warned and dropped at boot): the injected settings, the
// non-interactive/bare modes, and every mode flag the console selects by launch mode.
const conflictingArgs = ['--settings', '--bare', '--safe-mode', '-c', '--continue', '-r', '--resume', '--session-id', '-p', '--print'] as const;

/**
 * The Claude Code Adapter (chunk 2). State is reported through hooks (`stateSource:
 * 'reported'`), so the title carries no signal and `inferState` is always
 * `undefined`. Every launch injects the console-owned `hooks.json` through
 * `--settings`, leaving `~/.claude` untouched. There are no `turns` (fullscreen
 * viewport), no inline `questions` in v1 (the operator answers in the pane), no
 * `panes`, and `conversations` has no `discover` (the transcript fd is not held
 * open) — only a reported `@rac_session` id, titled from the transcript.
 */
export const claudeAdapter: Adapter = {
  kind: 'claude',
  stateSource: 'reported',
  conflictingArgs: [...conflictingArgs],
  recognizes,
  inferState: () => undefined,
  // fresh → --settings <file>; continue → --continue --settings <file>; resume →
  // --resume <id> --settings <file>. Nothing else; chunk 4 selects among settings
  // variants by availability and Sandboxed.
  launch: ({ mode, conversationId, files }) => {
    const settings = files?.[claudeHooksFileName];
    const settingsArgs = settings === undefined ? [] : ['--settings', settings];
    if (mode === 'continue') return { args: ['--continue', ...settingsArgs] };
    if (mode === 'resume' && conversationId !== undefined) return { args: ['--resume', conversationId, ...settingsArgs] };
    return { args: settingsArgs };
  },
  submission: {
    // both modes: paste the text and press Enter — no trailing space, never Tab
    prepare: (prompt) => ({ text: prompt, keys: ['Enter'] }),
    // Escape then C-c as separate writes; never Escape Escape (Rewind) or C-c C-c (exit)
    interrupt: ['Escape', 'C-c'],
    selectOption: (index) => [...Array.from({ length: index }, () => 'Down' as TmuxKey), 'Enter'],
  },
  commands: {
    stateDirectory: (env) => claudeConfigDir(env),
    skillDirectories: claudeSkillDirectories,
    slash: claudeSlash,
    skillInvocation: (name) => `/${name}`,
  },
  conversations: {
    validId: validClaudeSessionId,
    title: (id, cwd) => claudeConversationTitle(id, cwd),
  },
  files: claudeFiles,
};
