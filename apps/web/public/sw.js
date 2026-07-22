self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', event => { const data = event.data?.json() ?? {}; event.waitUntil(self.registration.showNotification(data.title ?? 'Remote Agent Console', { body: data.body ?? 'An agent is ready.', tag: data.tag, icon: '/favicon.svg', badge: '/notification-badge.png', data: { url: data.url ?? '/' } })); });
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const url = new URL(event.notification.data?.url ?? '/', self.location.origin).href;
    const existing = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = existing.find(candidate => new URL(candidate.url).origin === self.location.origin);
    if (client) { await client.navigate(url); return client.focus(); }
    return clients.openWindow(url);
  })());
});
