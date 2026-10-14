import { api } from './api.js';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const pushPermission = () => (pushSupported() ? Notification.permission : 'unsupported');

// iPhones only allow web push for apps added to the home screen.
export const needsHomeScreenInstall = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) && !window.matchMedia('(display-mode: standalone)').matches;

const keyBytes = (base64url) => {
  const raw = atob((base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

export async function registerServiceWorker() {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch (err) {
    console.warn('Service worker registration failed', err);
    return null;
  }
}

async function browserSubscription() {
  if (!pushSupported()) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}

export async function isPushOn() {
  return pushPermission() === 'granted' && Boolean(await browserSubscription());
}

/** Asks permission (must be called from a click), subscribes this browser and registers it for the signed-in user. */
export async function enablePush(publicKey) {
  if (!pushSupported()) throw new Error('This browser does not support notifications');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings.');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = keyBytes(publicKey);
  // A subscription made with an older server key can't be reused.
  if (sub && sub.options?.applicationServerKey && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/push/subscriptions', { method: 'POST', body: sub.toJSON() });
}

export async function disablePush() {
  const sub = await browserSubscription();
  if (!sub) return;
  await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
  await sub.unsubscribe();
}

/** After sign-in: if this browser already allowed push, link it to the account now signed in. */
export async function syncPushSubscription() {
  if (pushPermission() !== 'granted') return;
  const sub = await browserSubscription();
  if (sub) await api('/push/subscriptions', { method: 'POST', body: sub.toJSON() }).catch(() => {});
}

/** Before sign-out: stop this browser receiving the outgoing user's notifications. */
export async function detachPushSubscription() {
  const sub = await browserSubscription().catch(() => null);
  if (sub) await api('/push/subscriptions', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {});
}

function sameKey(buffer, bytes) {
  const a = new Uint8Array(buffer);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
}
