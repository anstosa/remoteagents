const fullGitShaPattern = /^[0-9a-f]{40}$/u;

// recognize one exact lowercase Git object id
export const isFullGitSha = (value: unknown): value is string => typeof value === 'string' && fullGitShaPattern.test(value);
