import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// lock the portable deployment boundary
async function repositoryFile(path: string): Promise<string> {
  return await readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
}

describe('portable deployment', () => {
  // keep worktree mounts outside tracked compose
  it('uses an environment-controlled proxy and no base worktree mounts', async () => {
    const compose = await repositoryFile('compose.yaml');

    expect(compose).toContain('RAC_PROJECT_PROXY_HOST: ${RAC_PROJECT_PROXY_HOST:-127.0.0.1}');
    expect(compose).toContain('RAC_BOOKMARKS_FILE: /workspace/.data/bookmarks.json');
    expect(compose).not.toMatch(/:\/worktrees\//);
    expect(compose).not.toContain('network_mode: "service:remote-agent-console"');
  });

  // keep installation files outside version control
  it('ignores per-host configuration and provides a generic override example', async () => {
    const ignore = await repositoryFile('.gitignore');
    const example = await repositoryFile('compose.override.example.yaml');

    expect(ignore).toContain('compose.override.yaml');
    expect(ignore).toContain('config/cloudflared.yml');
    expect(ignore).toContain('config/remote-agent-console.docker.json');
    expect(example).toContain('${HOME}/.codex:/home/node/.codex:rw');
    expect(example).not.toContain('.codex/auth.json:/home/node/.codex/auth.json');
    expect(example).toContain('/absolute/path/to/project:/worktrees/project:rw');
  });

  // require target-host source builds
  it('documents pull-then-build remote deployments', async () => {
    const guidance = await repositoryFile('AGENTS.md');

    expect(guidance).toContain('git pull --ff-only');
    expect(guidance).toContain('docker compose up -d --build');
    expect(guidance).toContain('Do not copy a working tree, built image, or generated artifact');
  });
});
