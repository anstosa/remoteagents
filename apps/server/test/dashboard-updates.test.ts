import { describe, expect, it } from 'vitest';
import { DashboardUpdates } from '../src/dashboard/updates.js';

describe('dashboard updates', () => {
  it('publishes changed snapshots, replays the current value, and coalesces concurrent refreshes', async () => {
    let value = { generation: 1, agents: [{ id: 'agent-1', title: 'Working' }], worktrees: [] };
    let loads = 0;
    let release: (() => void) | undefined;
    const updates = new DashboardUpdates<typeof value>(dashboard => JSON.stringify([dashboard.agents, dashboard.worktrees]));
    updates.setLoader(async () => {
      loads += 1;
      if (loads === 1) await new Promise<void>(resolve => { release = resolve; });
      return value;
    });
    const seen: typeof value[] = [];
    const unsubscribe = updates.subscribe(snapshot => seen.push(snapshot));

    const first = updates.refresh();
    const duplicate = updates.refresh();
    expect(loads).toBe(1);
    release?.();
    await Promise.all([first, duplicate]);
    expect(seen).toEqual([value]);

    await updates.refresh();
    expect(seen).toHaveLength(1);
    value = { ...value, generation: 2, agents: [{ id: 'agent-1', title: 'Ready' }] };
    await updates.refresh();
    expect(seen).toHaveLength(2);

    const replayed: typeof value[] = [];
    const stopReplay = updates.subscribe(snapshot => replayed.push(snapshot));
    expect(replayed).toEqual([value]);
    unsubscribe();
    stopReplay();
    updates.close();
  });

  it('isolates failed listeners and does not retain a failed replay subscription', async () => {
    let value = { agents: [{ id: 'agent-1' }], worktrees: [] as never[] };
    const updates = new DashboardUpdates<typeof value>();
    updates.setLoader(async () => value);
    const seen: typeof value[] = [];
    updates.subscribe(() => { throw new Error('closed socket'); });
    updates.subscribe(snapshot => seen.push(snapshot));

    await expect(updates.refresh()).resolves.toEqual(value);
    expect(seen).toEqual([value]);
    expect(() => updates.subscribe(() => { throw new Error('failed replay'); })).toThrow('failed replay');
    value = { agents: [{ id: 'agent-2' }], worktrees: [] };
    await expect(updates.refresh()).resolves.toEqual(value);
    expect(seen).toEqual([{ agents: [{ id: 'agent-1' }], worktrees: [] }, value]);
  });
});
