import type { AdapterFileContext, AttentionState } from './types.js';

/**
 * The Claude Code hooks settings file the console injects with `--settings` on
 * every launch and resume (ADR 0001). Its handlers map Claude's lifecycle events
 * to the console's Attention vocabulary and run `scripts/hooks/rac-attention`,
 * which writes the pane options the console polls. Hook entries merge additively
 * across settings levels, so the file adds these handlers and changes nothing
 * else in the operator's own settings.
 */

// the rendered file's name — the contract between what `claudeFiles` writes and
// what the Adapter's `launch` reads back out of `LaunchInput.files`
export const claudeHooksFileName = 'hooks.json';

type CommandHandler = { type: 'command'; timeout: number; command: string };
type HookEntry = { matcher?: string; hooks: CommandHandler[] };

// One reporter invocation for a state: the tmux binary baked in (omitted under the
// bridge, where the host's PATH tmux is used) and the script named by its host path.
function report(context: AdapterFileContext, state: AttentionState): CommandHandler {
  const prefix = context.tmuxBin === undefined ? '' : `RAC_TMUX_BIN=${context.tmuxBin} `;
  return { type: 'command', timeout: 5, command: `${prefix}${context.repoRoot}/scripts/hooks/rac-attention ${state}` };
}

// The event → state mapping (ADR 0001). `SessionStart` also registers the session
// id, which every invocation carries from `$CLAUDE_CODE_SESSION_ID`. `SessionEnd`
// deliberately reports nothing (Claude fires it on `/clear` and `/resume`).
export function claudeHooksSettings(context: AdapterFileContext): { hooks: Record<string, HookEntry[]> } {
  const working = [{ hooks: [report(context, 'working')] }];
  const finished = [{ hooks: [report(context, 'finished')] }];
  const question = [{ hooks: [report(context, 'question')] }];
  return {
    hooks: {
      SessionStart: finished,
      UserPromptSubmit: working,
      PreToolUse: [{ matcher: 'AskUserQuestion|ExitPlanMode', hooks: [report(context, 'question')] }],
      Elicitation: question,
      PermissionRequest: question,
      PostToolUse: working,
      PermissionDenied: working,
      ElicitationResult: working,
      Stop: finished,
      StopFailure: finished,
      Notification: [
        { matcher: 'permission_prompt', hooks: [report(context, 'question')] },
        { matcher: 'idle_prompt', hooks: [report(context, 'finished')] },
      ],
    },
  };
}

// The rendered `hooks.json` content, pretty-printed with a trailing newline.
export function claudeHooksJson(context: AdapterFileContext): string {
  return `${JSON.stringify(claudeHooksSettings(context), null, 2)}\n`;
}

// The Claude Adapter's `files` capability: one console-owned settings file.
export function claudeFiles(context: AdapterFileContext): Record<string, string> {
  return { [claudeHooksFileName]: claudeHooksJson(context) };
}
