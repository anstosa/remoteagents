import { expect, test, type CDPSession, type Page } from '@playwright/test';

const origin = process.env.RAC_PUSH_TEST_ORIGIN ?? 'http://127.0.0.1:4173';
const harnessPath = '/push-worker-harness';

// use full chromium so headless notification permissions remain available
test.use({ channel: 'chromium' });

type WorkerNotification = {
  title: string;
  body: string;
  tag: string;
  timestamp: number;
  requireInteraction: boolean;
  data: unknown;
};

// register the shipped worker and return its chromium registration id
async function registerPushWorker(page: Page, session: CDPSession) {
  let registrationId: string | undefined;
  // retain the matching registration from chromium updates
  session.on('ServiceWorker.workerRegistrationUpdated', event => {
    registrationId = event.registrations.find(registration => registration.scopeURL === `${origin}/` && !registration.isDeleted)?.registrationId ?? registrationId;
  });
  await session.send('ServiceWorker.enable');
  // keep the harness independent from the application backend
  await page.route(`**${harnessPath}`, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>push worker harness</title>' }));
  await page.goto(`${origin}${harnessPath}`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => registrationId).toBeTruthy();
  return registrationId!;
}

// deliver one synthetic push through chromium's service-worker pipeline
async function deliverPush(session: CDPSession, registrationId: string, payload: object) {
  await session.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(payload) });
}

// inspect notifications retained by the real browser registration
async function readNotifications(page: Page): Promise<WorkerNotification[]> {
  return await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    // reject a broken harness explicitly
    if (registration === undefined) throw new Error('service worker registration unavailable');
    const notifications = await registration.getNotifications();
    return notifications.map(notification => ({
      title: notification.title,
      body: notification.body,
      tag: notification.tag,
      timestamp: notification.timestamp,
      requireInteraction: notification.requireInteraction,
      data: notification.data as unknown
    }));
  });
}

// exercise actual push dispatch without a production subscription
test('shows, replaces, and retains worker notifications while the app is closed', async ({ context, page }) => {
  test.setTimeout(60_000);
  await context.grantPermissions(['notifications'], { origin });
  const session = await context.newCDPSession(page);
  const registrationId = await registerPushWorker(page, session);
  const firstSentAt = Date.now() - 60_000;
  const secondSentAt = firstSentAt + 15_000;

  await deliverPush(session, registrationId, {
    title: 'Question in Remote Agents',
    body: 'Cora: Choose a deployment target?',
    tag: 'worktree-status-cora-feature',
    kind: 'question',
    worktreeId: 'cora feature',
    url: '/#agent=stale-agent',
    sentAt: firstSentAt
  });
  await expect.poll(() => readNotifications(page)).toEqual([{
    title: 'Question in Remote Agents',
    body: 'Cora: Choose a deployment target?',
    tag: 'worktree-status-cora-feature',
    timestamp: firstSentAt,
    requireInteraction: true,
    data: { url: '/#worktree=cora%20feature', kind: 'question', worktreeId: 'cora feature' }
  }]);

  await deliverPush(session, registrationId, {
    title: 'Done working in Remote Agents',
    body: 'Cora is ready for a new prompt',
    tag: 'worktree-status-cora-feature',
    kind: 'finished',
    worktreeId: 'cora feature',
    sentAt: secondSentAt
  });
  await expect.poll(() => readNotifications(page)).toEqual([{
    title: 'Done working in Remote Agents',
    body: 'Cora is ready for a new prompt',
    tag: 'worktree-status-cora-feature',
    timestamp: secondSentAt,
    requireInteraction: false,
    data: { url: '/#worktree=cora%20feature', kind: 'finished', worktreeId: 'cora feature' }
  }]);

  await page.goto('about:blank');
  expect(context.pages().filter(candidate => candidate.url().startsWith(origin))).toHaveLength(0);
  const closedDeliveryStartedAt = Date.now();
  await deliverPush(session, registrationId, {
    title: 'Remote Agent Console update available',
    body: 'Legacy payload without an original timestamp',
    tag: 'rac-update',
    kind: 'system',
    url: '/#server-update'
  });

  await page.goto(`${origin}${harnessPath}`);
  await expect.poll(async () => (await readNotifications(page)).length).toBe(2);
  const finalNotifications = await readNotifications(page);
  // isolate the replaced and backward-compatible notifications
  const replacement = finalNotifications.find(notification => notification.tag === 'worktree-status-cora-feature');
  const legacy = finalNotifications.find(notification => notification.tag === 'rac-update');
  expect(replacement).toEqual({
    title: 'Done working in Remote Agents',
    body: 'Cora is ready for a new prompt',
    tag: 'worktree-status-cora-feature',
    timestamp: secondSentAt,
    requireInteraction: false,
    data: { url: '/#worktree=cora%20feature', kind: 'finished', worktreeId: 'cora feature' }
  });
  expect(legacy).toMatchObject({
    title: 'Remote Agent Console update available',
    body: 'Legacy payload without an original timestamp',
    tag: 'rac-update',
    requireInteraction: false,
    data: { url: '/#server-update', kind: 'system' }
  });
  expect(legacy?.timestamp).toBeGreaterThanOrEqual(closedDeliveryStartedAt);
  expect(legacy?.timestamp).toBeLessThanOrEqual(Date.now());
  await session.detach();
});
