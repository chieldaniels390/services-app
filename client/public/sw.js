// Service worker: shows push notifications and opens the right page when one is tapped.
// It deliberately has no fetch handler, so it never caches or intercepts the app's requests.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'ProNow', body: event.data?.text() };
  }
  event.waitUntil((async () => {
    // If the app is open and in front, it already shows this in-app.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (windows.some((w) => w.focused && w.visibilityState === 'visible')) return;
    await self.registration.showNotification(data.title || 'ProNow', {
      body: data.body,
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: data.url || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => 'focus' in w);
    if (existing) {
      await existing.focus();
      if ('navigate' in existing) return existing.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});
