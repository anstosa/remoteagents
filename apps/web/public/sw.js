self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  if (data.kind === 'dismiss') {
    event.waitUntil(self.registration.getNotifications().then(notifications => {
      for (const notification of notifications) {
        if (notification.tag === data.tag || notification.tag === data.legacyTag || (data.worktreeId !== undefined && notification.data?.worktreeId === data.worktreeId)) notification.close();
      }
    }));
    return;
  }
  event.waitUntil(self.registration.showNotification(data.title ?? 'Remote Agent Console', { body: data.body ?? 'An agent is ready.', tag: data.tag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: data.kind === 'question', data: { url: data.url ?? '/', kind: data.kind, worktreeId: data.worktreeId } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
    const existing = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = existing.find(candidate => new URL(candidate.url).origin === self.location.origin);
    if (client) {
      const target = await client.navigate(url).catch(() => client);
      return (target?.focus() ?? Promise.resolve()).catch(() => clients.openWindow(url));
    }
    return clients.openWindow(url);
  })());
});
