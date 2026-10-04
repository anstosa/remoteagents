import { describe, expect, it } from 'vitest';
import { runInNewContext } from 'node:vm';
import { projectBrowserPermissions } from '../src/project-browser-permissions.js';

type PermissionRequest = {
  clientId: string;
  id: string;
  notificationId?: string;
  operation?: string;
  options?: Record<string, unknown>;
  title?: string;
  type: string;
  watchId?: string;
};

type PermissionResponse = {
  clientId?: string;
  error?: { code: number; message: string };
  event?: string;
  id?: string;
  notificationId?: string;
  permission?: string;
  position?: unknown;
  status?: string;
  type?: string;
  watchId?: string;
};

type Timer = { callback: () => void; delay: number };

// execute the generated shim against one controlled child window
const executePermissions = (options: { embedded?: boolean; name?: string; nested?: boolean; secure?: boolean } = {}) => {
  const requests: PermissionRequest[] = [];
  const listeners = new Map<string, Array<(event: any) => void>>();
  const timers = new Map<number, Timer>();
  let nextTimer = 1;
  let nextUuid = 1;
  const nativeGeolocation = { native: true };
  class NativeNotification {}
  const parent = {
    // retain one outgoing broker request
    postMessage: (message: PermissionRequest, target: string) => {
      expect(target).toBe('https://agents.example.com');
      requests.push(message);
    }
  };
  const window: any = {
    Notification: NativeNotification,
    // retain child-window listeners
    addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, [...listeners.get(name) ?? [], listener]),
    // release one fake deadline
    clearTimeout: (id: number) => timers.delete(id),
    crypto: {
      // issue stable UUID-shaped protocol identifiers
      randomUUID: () => `00000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`
    },
    isSecureContext: options.secure ?? true,
    name: options.name ?? 'rac-managed-preview-v1',
    navigator: { geolocation: nativeGeolocation },
    parent,
    top: options.nested === true ? {} : parent,
    // retain one fake deadline
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    }
  };
  // model a top-level window when requested
  if (options.embedded === false) { window.parent = window; window.top = window; }
  runInNewContext(projectBrowserPermissions('https://agents.example.com'), { window });
  // dispatch one window event
  const dispatch = (name: string, event: any) => {
    // notify every retained listener
    for (const listener of listeners.get(name) ?? []) listener(event);
  };
  // return the newest request for one operation
  const request = (operation: string) => {
    const match = [...requests].reverse().find(value => value.operation === operation);
    // fail loudly when production did not send the expected request
    if (match === undefined) throw new Error(`missing ${operation} request`);
    return match;
  };
  // deliver one exact parent response
  const respond = (outgoing: PermissionRequest, response: PermissionResponse = {}, authority: { origin?: string; source?: object } = {}) => dispatch('message', {
    data: {
      type: 'rac-browser-permission-response',
      clientId: outgoing.clientId,
      id: outgoing.id,
      status: 'ok',
      ...response
    },
    origin: authority.origin ?? 'https://agents.example.com',
    source: authority.source ?? parent
  });
  // run every currently retained deadline once
  const expireTimers = () => {
    const retained = [...timers.entries()];
    timers.clear();
    // execute a stable timer snapshot
    for (const [, timer] of retained) timer.callback();
  };
  return { NativeNotification, dispatch, expireTimers, nativeGeolocation, parent, request, requests, respond, timers, window };
};

// create one complete serialized position
const position = (latitude: number, timestamp: number) => ({
  coords: {
    accuracy: 4,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    latitude,
    longitude: -122.4,
    speed: null
  },
  timestamp
});

describe('project browser permission shim', () => {
  // preserve native APIs outside eligible managed frames
  it('installs only in secure direct console frames and starts a scoped session', () => {
    const embedded = executePermissions();
    expect(embedded.requests).toHaveLength(1);
    expect(embedded.requests[0]).toMatchObject({ type: 'rac-browser-permission-request', operation: 'connect' });
    expect(embedded.requests[0]?.clientId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(embedded.window.navigator.geolocation).not.toBe(embedded.nativeGeolocation);
    expect(embedded.window.Notification).not.toBe(embedded.NativeNotification);
    expect(embedded.window.Notification.permission).toBe('default');

    const topLevel = executePermissions({ embedded: false });
    expect(topLevel.requests).toEqual([]);
    expect(topLevel.window.navigator.geolocation).toBe(topLevel.nativeGeolocation);
    expect(topLevel.window.Notification).toBe(topLevel.NativeNotification);

    const insecure = executePermissions({ secure: false });
    expect(insecure.requests).toEqual([]);
    expect(insecure.window.navigator.geolocation).toBe(insecure.nativeGeolocation);
    expect(insecure.window.Notification).toBe(insecure.NativeNotification);
  });

  // preserve native permissions in nested and unrecognized embedding contexts
  it('leaves nested and non-console embeddings untouched', () => {
    const excluded = [
      executePermissions({ nested: true }),
      executePermissions({ name: 'rac-managed-preview-v2' }),
      executePermissions({ name: '' }),
      executePermissions({ name: 'project-frame' })
    ];
    // verify exact native identities without requesting browser permissions
    for (const bridge of excluded) {
      expect(bridge.requests).toEqual([]);
      expect(bridge.window.navigator.geolocation).toBe(bridge.nativeGeolocation);
      expect(bridge.window.Notification).toBe(bridge.NativeNotification);
      expect(bridge.timers.size).toBe(0);
    }
  });

  // restore only a validated parent-owned notification grant after connecting
  it('restores remembered notification permission from a successful handshake', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'), { permission: 'granted' });
    expect(bridge.window.Notification.permission).toBe('granted');
    const invalid = executePermissions();
    invalid.respond(invalid.request('connect'), { permission: 'always' });
    expect(invalid.window.Notification.permission).toBe('default');
  });

  // validate authority and serialize location traffic
  it('forwards bounded current positions and rejects forged or malformed replies', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const successes: unknown[] = [];
    const errors: Array<{ code: number }> = [];
    bridge.window.navigator.geolocation.getCurrentPosition((value: unknown) => successes.push(value), (error: { code: number }) => errors.push(error), {
      enableHighAccuracy: 'yes',
      maximumAge: Number.POSITIVE_INFINITY,
      timeout: 999999
    });
    const outgoing = bridge.request('geolocation-get');
    expect(outgoing.options).toEqual({ enableHighAccuracy: false, maximumAge: 0, timeout: 60000 });
    expect([...bridge.timers.values()].map(timer => timer.delay)).toContain(180000);

    bridge.respond(outgoing, { position: position(40.7, 10) }, { origin: 'https://evil.example.com' });
    bridge.respond(outgoing, { position: position(40.7, 10) }, { source: {} });
    bridge.respond(outgoing, { clientId: '00000000-0000-4000-8000-999999999999', position: position(40.7, 10) });
    bridge.respond(outgoing, { position: { coords: { latitude: 500 }, timestamp: 10 } });
    expect(successes).toEqual([]);
    expect(errors).toEqual([]);

    bridge.respond(outgoing, { position: position(40.7, 10) });
    expect(successes).toEqual([position(40.7, 10)]);
    bridge.respond(outgoing, { position: position(41, 11) });
    expect(successes).toHaveLength(1);
  });

  // preserve browser denial codes and watch cancellation semantics
  it('reports denials and forwards repeated watch positions until clear', () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    const denied: Array<{ code: number; message: string }> = [];
    bridge.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number; message: string }) => denied.push(error));
    const lookup = bridge.request('geolocation-get');
    bridge.respond(lookup, { status: 'denied', error: { code: 1, message: 'not approved' } });
    expect(denied).toMatchObject([{ code: 1, message: 'not approved' }]);

    const positions: unknown[] = [];
    const watchId = bridge.window.navigator.geolocation.watchPosition((value: unknown) => positions.push(value), () => undefined, { enableHighAccuracy: true, maximumAge: 50, timeout: 75 });
    const watch = bridge.request('geolocation-watch');
    expect(watchId).toBe(1);
    expect(watch.watchId).toBeUndefined();
    expect(watch.options).toEqual({ enableHighAccuracy: true, maximumAge: 50, timeout: 75 });
    bridge.respond(watch, { position: position(47.6, 20), watchId: watch.id });
    bridge.respond(watch, { position: position(47.7, 21), watchId: watch.id });
    expect(positions).toEqual([position(47.6, 20), position(47.7, 21)]);

    bridge.window.navigator.geolocation.clearWatch(watchId);
    const clear = bridge.request('geolocation-clear');
    expect(clear.id).not.toBe(watch.id);
    expect(clear.watchId).toBe(watch.id);
    bridge.respond(watch, { position: position(47.8, 22), watchId: watch.id });
    expect(positions).toHaveLength(2);
    bridge.respond(clear);
  });

  // model permission, construction, lifecycle events, and close forwarding
  it('provides a constrained Notification surface with forwarded events', async () => {
    const bridge = executePermissions();
    bridge.respond(bridge.request('connect'));
    expect(() => new bridge.window.Notification('blocked')).toThrowError(expect.objectContaining({ name: 'NotAllowedError' }));
    let callbackPermission: string | undefined;
    const permissionPromise = bridge.window.Notification.requestPermission((permission: string) => { callbackPermission = permission; });
    const permission = bridge.request('notification-permission');
    bridge.respond(permission, { permission: 'granted' });
    await expect(permissionPromise).resolves.toBe('granted');
    expect(callbackPermission).toBe('granted');
    expect(bridge.window.Notification.permission).toBe('granted');

    const events: string[] = [];
    const notification = new bridge.window.Notification('t'.repeat(250), {
      actions: [{ action: 'unsafe', title: 'unsafe' }],
      body: 'b'.repeat(2100),
      data: { secret: true },
      icon: 'https://evil.example.com/icon.png',
      requireInteraction: true,
      silent: 'yes',
      tag: 'x'.repeat(140)
    });
    notification.onshow = () => events.push('property-show');
    notification.addEventListener('show', () => events.push('listener-show'));
    notification.addEventListener('click', () => events.push('click'));
    notification.addEventListener('close', () => events.push('close'));
    const show = bridge.request('notification-show');
    expect(show.notificationId).toBeUndefined();
    expect(show.title).toHaveLength(200);
    expect(show.options).toEqual({ body: 'b'.repeat(2000), tag: 'x'.repeat(128), requireInteraction: true, silent: false });
    expect(show.options).not.toHaveProperty('icon');
    expect(show.options).not.toHaveProperty('actions');
    expect(show.options).not.toHaveProperty('data');

    bridge.respond(show, { event: 'show', notificationId: show.id });
    bridge.respond(show, { event: 'click', notificationId: show.id });
    expect(events).toEqual(['property-show', 'listener-show', 'click']);
    notification.close();
    const close = bridge.request('notification-close');
    expect(close.id).not.toBe(show.id);
    expect(close.notificationId).toBe(show.id);
    bridge.respond(close, { notificationId: show.id });
    bridge.respond(show, { event: 'close', notificationId: show.id });
    expect(events).toEqual(['property-show', 'listener-show', 'click', 'close']);
    bridge.respond(show, { event: 'click', notificationId: show.id });
    expect(events).toHaveLength(4);

    const deniedPromise = bridge.window.Notification.requestPermission();
    const denied = bridge.request('notification-permission');
    bridge.respond(denied, { status: 'denied' });
    await expect(deniedPromise).resolves.toBe('denied');
    expect(bridge.window.Notification.permission).toBe('denied');
  });

  // settle retained callbacks on timeout and document disconnect
  it('settles deadlines and disconnects without accepting late responses', async () => {
    const timed = executePermissions();
    timed.respond(timed.request('connect'));
    const timedErrors: number[] = [];
    timed.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number }) => timedErrors.push(error.code), { timeout: 5 });
    const lookup = timed.request('geolocation-get');
    timed.expireTimers();
    expect(timedErrors).toEqual([3]);
    expect(timed.request('geolocation-clear').watchId).toBe(lookup.id);
    timed.respond(lookup, { position: position(40, 30) });
    expect(timedErrors).toEqual([3]);

    const queuedWatch = executePermissions();
    queuedWatch.respond(queuedWatch.request('connect'));
    queuedWatch.window.navigator.geolocation.watchPosition(() => undefined, () => undefined, { timeout: 5 });
    const watch = queuedWatch.request('geolocation-watch');
    queuedWatch.expireTimers();
    const watchCancel = queuedWatch.request('geolocation-clear');
    expect(watchCancel.id).not.toBe(watch.id);
    expect(watchCancel.watchId).toBe(watch.id);

    const permissionTimeout = executePermissions();
    permissionTimeout.respond(permissionTimeout.request('connect'));
    const rejectedPermission = permissionTimeout.window.Notification.requestPermission();
    const permission = permissionTimeout.request('notification-permission');
    permissionTimeout.expireTimers();
    const permissionCancel = permissionTimeout.request('notification-close');
    expect(permissionCancel.notificationId).toBe(permission.id);
    await expect(rejectedPermission).rejects.toMatchObject({ name: 'AbortError', message: 'permission broker timed out' });

    const showTimeout = executePermissions();
    showTimeout.respond(showTimeout.request('connect'));
    const granted = showTimeout.window.Notification.requestPermission();
    showTimeout.respond(showTimeout.request('notification-permission'), { permission: 'granted' });
    await granted;
    const notificationErrors: string[] = [];
    const notification = new showTimeout.window.Notification('timed out');
    notification.addEventListener('error', () => notificationErrors.push('error'));
    const show = showTimeout.request('notification-show');
    showTimeout.expireTimers();
    const showCancel = showTimeout.request('notification-close');
    expect(showCancel.notificationId).toBe(show.id);
    expect(notificationErrors).toEqual(['error']);

    const disconnected = executePermissions();
    disconnected.respond(disconnected.request('connect'));
    const disconnectErrors: number[] = [];
    disconnected.window.navigator.geolocation.watchPosition(() => undefined, (error: { code: number }) => disconnectErrors.push(error.code));
    const disconnectedWatch = disconnected.request('geolocation-watch');
    disconnected.dispatch('pagehide', {});
    expect(disconnectErrors).toEqual([2]);
    expect(disconnected.requests).toContainEqual(expect.objectContaining({ type: 'rac-browser-permission-disconnect', clientId: disconnectedWatch.clientId }));
    expect(disconnected.request('geolocation-clear').watchId).toBe(disconnectedWatch.id);
    await expect(disconnected.window.Notification.requestPermission()).rejects.toMatchObject({ name: 'AbortError' });
    disconnected.dispatch('pageshow', { persisted: true });
    const restoredConnect = disconnected.request('connect');
    expect(restoredConnect.clientId).not.toBe(disconnectedWatch.clientId);
    expect(disconnected.window.Notification.permission).toBe('default');
  });

  // enforce broker-aligned request and resource caps
  it('bounds retained consent, watches, and notifications', async () => {
    const watches = executePermissions();
    watches.respond(watches.request('connect'));
    const watchErrors: number[] = [];
    // fill the active watch allowance
    for (let index = 0; index < 8; index += 1) watches.window.navigator.geolocation.watchPosition(() => undefined, () => undefined);
    const overflowWatchId = watches.window.navigator.geolocation.watchPosition(() => undefined, (error: { code: number }) => watchErrors.push(error.code));
    expect(typeof overflowWatchId).toBe('number');
    expect(watches.requests.filter(request => request.operation === 'geolocation-watch')).toHaveLength(8);
    expect(watchErrors).toEqual([2]);

    const consent = executePermissions();
    consent.respond(consent.request('connect'));
    const consentErrors: number[] = [];
    // fill the pending consent allowance
    for (let index = 0; index < 16; index += 1) consent.window.navigator.geolocation.getCurrentPosition(() => undefined, () => undefined);
    consent.window.navigator.geolocation.getCurrentPosition(() => undefined, (error: { code: number }) => consentErrors.push(error.code));
    expect(consent.requests.filter(request => request.operation === 'geolocation-get')).toHaveLength(16);
    expect(consentErrors).toEqual([2]);

    const notifications = executePermissions();
    notifications.respond(notifications.request('connect'));
    const permission = notifications.window.Notification.requestPermission();
    notifications.respond(notifications.request('notification-permission'), { permission: 'granted' });
    await permission;
    // bound retained handles without blocking parent reconciliation after sixteen notices
    for (let index = 0; index < 32; index += 1) {
      new notifications.window.Notification(`notification ${index}`);
      const show = notifications.request('notification-show');
      notifications.respond(show, { notificationId: show.id });
    }
    expect(() => new notifications.window.Notification('overflow')).toThrowError(expect.objectContaining({ name: 'QuotaExceededError' }));
    expect(notifications.requests.filter(request => request.operation === 'notification-show')).toHaveLength(32);
  });
});
