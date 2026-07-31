import { describe, expect, it } from 'vitest';
import { isAgentCommand } from '../src/discovery/processes.js';

describe('isAgentCommand', () => {
  it('recognizes the Node launcher used by current Codex installations', () => {
    expect(isAgentCommand('MainThread', 'node\0/home/ubuntu/n/bin/codex\0')).toBe(true);
  });

  it('does not treat unrelated Node processes as agents', () => {
    expect(isAgentCommand('node', 'node\0/app/server.js\0')).toBe(false);
  });

  it('does not treat an OMX HUD process as an agent', () => {
    expect(isAgentCommand('MainThread', 'node\0/home/ubuntu/n/bin/omx\0hud\0--watch\0')).toBe(false);
  });
});
