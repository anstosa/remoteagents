self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
self.addEventListener('push', event => { const data = event.data?.json() ?? {}; event.waitUntil(self.registration.showNotification(data.title ?? 'Remote Agent Console', { body: data.body ?? 'An agent is ready.', tag: data.tag, icon: '/favicon.svg', data: { url: data.url ?? '/' } })); });
self.addEventListener('notificationclick', event => { event.notification.close(); event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(existing => existing[0]?.focus() ?? clients.openWindow(event.notification.data.url))); });
