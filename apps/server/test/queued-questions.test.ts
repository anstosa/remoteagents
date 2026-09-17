import { describe, expect, it, vi } from 'vitest';
import { PromptService } from '../src/prompts/service.js';

const banner = '• Queued follow-up inputs\n  ? 1 question\n    alt + ↑ to answer\n\n› Ask Codex to do anything\n  gpt-6-astra · /repo · main';
const socket = { fingerprint: 'socket', path: '/tmp/queued-question-test', device: 1, inode: 1 };
const agent = { id: 'socket:%1', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/repo', kind: 'codex', title: 'Ready', attention: 'finished' };

// exercise real prompt guards without typing into a live agent
function fixture() {
  const target = vi.fn(async () => ({ agent, socket }));
  const capture = vi.fn(async (): Promise<string | undefined> => banner);
  const sendKeys = vi.fn(async () => true);
  const service = new PromptService({ target, worktreesNow: () => [] } as never, { capture, sendKeys } as never);
  return { target, capture, sendKeys, service };
}

// opening the editor must never submit a default answer or interrupt agent work
describe('native queued question activation', () => {
  // suppress repeats across viewers until the collapsed footer disappears
  it('opens once, preserves manual collapse, and rearms after completion', async () => {
    const { service, sendKeys } = fixture();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys.mock.calls).toEqual([[socket, '%1', ['M-Up']]]);
    await expect(service.openQueuedQuestion(agent.id, '• Queued follow-up inputs\nWhich approach?\n› 1. Small\n  2. Other\nenter submit   ctrl + ] skip   shift + → main prompt', () => true)).resolves.toBe(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    await service.openQueuedQuestion(agent.id, '› Ask Codex to do anything', () => true);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // reserve automatic input synchronously after resolving the target
  it('coalesces simultaneous viewers', async () => {
    const { service, sendKeys } = fixture();
    const results = await Promise.all([service.openQueuedQuestion(agent.id, banner, () => true), service.openQueuedQuestion(agent.id, banner, () => true)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });

  // honor the viewer control lease across asynchronous reads
  it('does not open after control is lost', async () => {
    const { service, capture, sendKeys } = fixture();
    let active = true;
    capture.mockImplementation(async () => { active = false; return banner; });
    await expect(service.openQueuedQuestion(agent.id, banner, () => active)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // refuse stale or unavailable captures without consuming future attempts
  it.each([undefined, 'already answered', banner.replace('alt + ↑', 'shift + ←')])('revalidates the live shortcut %s', async current => {
    const { service, capture, sendKeys } = fixture();
    capture.mockResolvedValueOnce(current);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // keep all other adapters untouched
  it('ignores unsupported adapters', async () => {
    const { service, target, capture, sendKeys } = fixture();
    target.mockResolvedValue({ agent: { ...agent, kind: 'claude' }, socket });
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(capture).not.toHaveBeenCalled();
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // refuse a target replaced between capture and delivery
  it.each([
    { agent: { ...agent, paneId: '%2' }, socket },
    { agent, socket: { ...socket, fingerprint: 'other' } },
    { agent: { ...agent, kind: 'claude' }, socket }
  ])('revalidates target identity %j', async changed => {
    const { service, target, sendKeys } = fixture();
    target.mockResolvedValueOnce({ agent, socket }).mockResolvedValueOnce(changed);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // leave already active user operations alone
  it('waits for active manual input', async () => {
    const { service, sendKeys } = fixture();
    const release = service.beginAgentMutation(agent.id)!;
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    release();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // a manual operation must not hide the transition into the opened editor
  it('rearms when the footer disappears during manual input', async () => {
    const { service, sendKeys } = fixture();
    await service.openQueuedQuestion(agent.id, banner, () => true);
    const release = service.beginAgentMutation(agent.id)!;
    await service.openQueuedQuestion(agent.id, 'Which approach?\n› 1. Small\n  2. Other', () => true);
    release();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
    expect(sendKeys).toHaveBeenCalledTimes(2);
  });

  // a restart reservation blocks automatic keystrokes
  it('respects restart reservations', async () => {
    const { service, sendKeys } = fixture();
    const release = await service.acquireRestartLock(agent.id);
    expect(release).toBeDefined();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
    release!();
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });

  // a manual key arriving during revalidation wins
  it('abandons automatic input when the mutation generation changes', async () => {
    const { service, capture, sendKeys } = fixture();
    capture.mockImplementation(async () => { service.beginAgentMutation(agent.id)!(); return banner; });
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // only successful delivery suppresses a later attempt
  it('retries failed delivery and releases its mutation reservation', async () => {
    const { service, sendKeys } = fixture();
    sendKeys.mockResolvedValueOnce(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(false);
    await expect(service.openQueuedQuestion(agent.id, banner, () => true)).resolves.toBe(true);
  });
});
