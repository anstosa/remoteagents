import { join } from 'node:path';
import type { PromptCommand } from './types.js';

/**
 * A curated slash catalogue of Claude Code's in-session commands (research §7). The
 * full built-in list is large and plan-dependent, so the console ships a short list
 * of the commands that make sense mid-session and merges it with the skill catalogue
 * (one deduped `/` list; a skill of the same name wins).
 */
export function claudeSlash(): PromptCommand[] {
  return [
    { name: '/help', description: 'Show available commands' },
    { name: '/clear', description: 'Clear the conversation and start fresh' },
    { name: '/compact', description: 'Summarize the conversation to free up context' },
    { name: '/context', description: 'Show what is using the context window' },
    { name: '/resume', description: 'Resume a previous conversation' },
    { name: '/rewind', description: 'Rewind the conversation and code to an earlier point' },
    { name: '/model', description: 'Choose the model and reasoning effort' },
    { name: '/agents', description: 'View and switch between agent sessions' },
    { name: '/config', description: 'Open the settings' },
    { name: '/permissions', description: 'Choose what Claude is allowed to do' },
    { name: '/rename', description: 'Rename the current session' },
    { name: '/fork', description: 'Fork the current conversation' },
    { name: '/export', description: 'Export the conversation' },
    { name: '/copy', description: 'Copy the last response' },
    { name: '/diff', description: 'Show the git diff' },
    { name: '/init', description: 'Create a CLAUDE.md with instructions for Claude' },
    { name: '/memory', description: 'Edit Claude memory files' },
    { name: '/review', description: 'Review the current changes' },
    { name: '/todo', description: 'Show the current to-do list' },
    { name: '/hooks', description: 'View and manage lifecycle hooks' },
    { name: '/status', description: 'Show the session configuration and usage' },
    { name: '/usage', description: 'View account usage and rate limits' },
    { name: '/vim', description: 'Toggle Vim mode for the composer' },
    { name: '/theme', description: 'Choose a color theme' },
  ];
}

/**
 * Claude loads skills from the account-global directory and the workspace's own
 * `.claude/skills` (docs/skills). The console injects the state directory root; the
 * Adapter only names the paths. A skill is invoked as `/name`.
 */
export function claudeSkillDirectories(workspace: string, stateDirectory: string): string[] {
  return [join(stateDirectory, 'skills'), join(workspace, '.claude', 'skills')];
}
