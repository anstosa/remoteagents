self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', event => {
  const data = event.data?.json() ?? {};
  // prefer durable worktree destinations
  const url = typeof data.worktreeId === 'string' ? `/#worktree=${encodeURIComponent(data.worktreeId)}` : data.url ?? '/';
  event.waitUntil(self.registration.showNotification(data.title ?? 'Remote Agent Console', { body: data.body ?? 'An agent is ready.', tag: data.tag, icon: '/favicon.svg', badge: '/notification-badge.png', requireInteraction: data.kind === 'question', data: { url, kind: data.kind, worktreeId: data.worktreeId } }));
});
// route notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    // upgrade already displayed notifications
    const worktreeId = event.notification.data?.worktreeId;
    const destination = typeof worktreeId === 'string' ? `/#worktree=${encodeURIComponent(worktreeId)}` : event.notification.data?.url ?? '/';
    const url = new URL(destination, self.location.origin).href;
    const existing = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = existing.find(candidate => new URL(candidate.url).origin === self.location.origin);
    if (client) {
      const target = await client.navigate(url).catch(() => client);
      return (target?.focus() ?? Promise.resolve()).catch(() => clients.openWindow(url));
    }
    return clients.openWindow(url);
  })());
});
