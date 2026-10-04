import { expect, test, type BrowserContext, type FrameLocator, type Page } from '@playwright/test';
import { createServer, request as sendRequest } from 'node:http';
import { ProjectProxy } from '../../server/src/project-proxy.js';
import { installPaneMock, seedPaneSize } from './pane-stream-mock.js';

const consoleOrigin = 'http://127.0.0.1:4173';
const managedOrigin = 'https://project.example.com';
const directOrigin = 'https://external-preview.example';
const managedFrameName = 'rac-managed-preview-v1';

type ProviderState = {
  geolocationGets: number;
  geolocationWatches: number;
  geolocationClears: number[];
  notificationRequests: Array<{ active: boolean }>;
  notifications: Array<{ title: string; body?: string; closed: boolean }>;
};

// load the production bridge through its real proxy endpoint
const projectBrowserBridge = async () => {
  const proxy = new ProjectProxy(() => [{ projectUrl: managedOrigin, projectPort: 1 }], consoleOrigin);
  const server = createServer((request, response) => {
    // reject unrelated virtual hosts and paths
    if (!proxy.handle(request, response)) { response.writeHead(404); response.end(); }
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      // reject unexpected non-tcp listeners
      if (address === null || typeof address === 'string') { reject(new Error('missing browser bridge listener')); return; }
      resolve(address.port);
    });
  });
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = sendRequest({ hostname: '127.0.0.1', port, path: '/__rac/browser-bridge.js', headers: { host: 'project.example.com' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      });
      request.once('error', reject);
      request.end();
    });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
};

// install deterministic parent providers without replacing the broker
const installParentProviders = async (context: BrowserContext) => {
  await context.setGeolocation({ latitude: 47.6062, longitude: -122.3321, accuracy: 12 });
  await context.grantPermissions(['geolocation'], { origin: consoleOrigin });
  await context.addInitScript(parentOrigin => {
    // leave preview-native apis for the production bridge to replace
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    const geolocation = navigator.geolocation;
    const getCurrentPosition = geolocation.getCurrentPosition.bind(geolocation);
    const watchPosition = geolocation.watchPosition.bind(geolocation);
    const clearWatch = geolocation.clearWatch.bind(geolocation);
    Object.defineProperties(geolocation, {
      getCurrentPosition: {
        configurable: true,
        // record one parent location lookup
        value: (...args: Parameters<Geolocation['getCurrentPosition']>) => { state.geolocationGets += 1; return getCurrentPosition(...args); }
      },
      watchPosition: {
        configurable: true,
        // record one parent location watch
        value: (...args: Parameters<Geolocation['watchPosition']>) => { state.geolocationWatches += 1; return watchPosition(...args); }
      },
      clearWatch: {
        configurable: true,
        // record one parent watch cancellation
        value: (id: number) => { state.geolocationClears.push(id); clearWatch(id); }
      }
    });
    class ParentNotification extends EventTarget {
      static permission: NotificationPermission = 'default';
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ParentNotification.permission = 'granted';
        return ParentNotification.permission;
      }
      readonly title: string;
      readonly options?: NotificationOptions;
      readonly index: number;
      onshow: ((event: Event) => void) | null = null;
      onclose: ((event: Event) => void) | null = null;
      // retain one native notification request
      constructor(title: string, options?: NotificationOptions) {
        super();
        this.title = title;
        this.options = options;
        this.index = state.notifications.push({ title, ...(options?.body === undefined ? {} : { body: options.body }), closed: false }) - 1;
        queueMicrotask(() => {
          const event = new Event('show');
          this.dispatchEvent(event);
          this.onshow?.(event);
        });
      }
      // expose native close propagation
      close() {
        state.notifications[this.index]!.closed = true;
        const event = new Event('close');
        this.dispatchEvent(event);
        this.onclose?.(event);
      }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ParentNotification });
  }, consoleOrigin);
};

// install absent parent capabilities while retaining a call record
const installUnsupportedParentProviders = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined });
    Reflect.deleteProperty(window, 'Notification');
  }, consoleOrigin);
};

// retain child-native identities before any document script runs
const installNativePermissionReferenceCapture = async (context: BrowserContext) => {
  await context.addInitScript(origin => {
    // leave unrelated documents unchanged
    if (location.origin !== origin) return;
    const geolocation = navigator.geolocation;
    Object.defineProperty(window, '__nativePermissionApis', { configurable: true, value: {
      geolocation,
      getCurrentPosition: geolocation?.getCurrentPosition,
      watchPosition: geolocation?.watchPosition,
      clearWatch: geolocation?.clearWatch,
      notification: window.Notification,
      notificationRequestPermission: window.Notification?.requestPermission
    } });
  }, managedOrigin);
};

// compare every api identity the production bridge can replace
const nativePermissionApisPreserved = (frame: FrameLocator) => frame.locator('body').evaluate(() => {
  const native = (window as typeof window & { __nativePermissionApis: {
    geolocation: Geolocation | undefined;
    getCurrentPosition: Geolocation['getCurrentPosition'] | undefined;
    watchPosition: Geolocation['watchPosition'] | undefined;
    clearWatch: Geolocation['clearWatch'] | undefined;
    notification: typeof Notification | undefined;
    notificationRequestPermission: typeof Notification.requestPermission | undefined;
  } }).__nativePermissionApis;
  return {
    geolocation: native.geolocation === navigator.geolocation,
    getCurrentPosition: native.getCurrentPosition === navigator.geolocation?.getCurrentPosition,
    watchPosition: native.watchPosition === navigator.geolocation?.watchPosition,
    clearWatch: native.clearWatch === navigator.geolocation?.clearWatch,
    notification: native.notification === window.Notification,
    notificationRequestPermission: native.notificationRequestPermission === window.Notification?.requestPermission
  };
});

// install a delayed service-worker display fallback
const installServiceWorkerNotificationProvider = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    class ThrowingNotification {
      static permission: NotificationPermission = 'default';
      // preserve native activation evidence
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ThrowingNotification.permission = 'granted';
        return ThrowingNotification.permission;
      }
      // force the mobile-style worker fallback
      constructor() { throw new Error('foreground notifications unavailable'); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ThrowingNotification });
    const registration = {
      // retain worker-backed display attempts
      showNotification: async (title: string, options?: NotificationOptions) => { state.notifications.push({ title, ...(options?.body === undefined ? {} : { body: options.body }), closed: false }); },
      getNotifications: async () => []
    };
    let resolveRegistration!: (value: typeof registration) => void;
    const pendingRegistration = new Promise<typeof registration>(resolve => { resolveRegistration = resolve; });
    Object.defineProperty(window, '__resolvePreviewRegistration', { configurable: true, value: () => resolveRegistration(registration) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: () => pendingRegistration, ready: pendingRegistration, register: async () => registration } });
  }, consoleOrigin);
};

// install a worker provider that records dismissal and same-tag replacement
const installReconcilingWorkerProvider = async (context: BrowserContext) => {
  await context.addInitScript(parentOrigin => {
    // leave the managed child for the production bridge
    if (location.origin !== parentOrigin) return;
    const state: ProviderState = { geolocationGets: 0, geolocationWatches: 0, geolocationClears: [], notificationRequests: [], notifications: [] };
    Object.defineProperty(window, '__permissionProviderState', { configurable: true, value: state });
    class ThrowingNotification {
      static permission: NotificationPermission = 'default';
      // grant the one parent-owned native prompt
      static async requestPermission() {
        state.notificationRequests.push({ active: navigator.userActivation.isActive });
        ThrowingNotification.permission = 'granted';
        return ThrowingNotification.permission;
      }
      // force every display through the worker provider
      constructor() { throw new Error('foreground notifications unavailable'); }
    }
    Object.defineProperty(window, 'Notification', { configurable: true, value: ThrowingNotification });
    type WorkerRecord = { title: string; tag: string; data?: Record<string, unknown>; reason?: string };
    const active = new Map<string, WorkerRecord & { close: () => void }>();
    const shows: WorkerRecord[] = [];
    const removed: WorkerRecord[] = [];
    let getNotifications = 0;
    // remove one worker notification with evidence
    const remove = (record: WorkerRecord & { close: () => void }, reason: string) => {
      // ignore duplicate dismissal signals
      if (active.get(record.tag) !== record) return;
      active.delete(record.tag);
      removed.push({ title: record.title, tag: record.tag, data: record.data, reason });
    };
    const registration = {
      // model os replacement by worker tag
      showNotification: async (title: string, options?: NotificationOptions) => {
        const tag = options?.tag ?? '';
        const replaced = active.get(tag);
        // remove the prior os-owned display for one reused tag
        if (replaced !== undefined) remove(replaced, 'replaced');
        const record = { title, tag, data: options?.data as Record<string, unknown> | undefined, close: () => remove(record, 'closed') };
        active.set(tag, record);
        shows.push({ title, tag, data: record.data });
      },
      // expose only notifications the os still displays
      getNotifications: async ({ tag }: { tag?: string } = {}) => {
        getNotifications += 1;
        return [...active.values()].filter(record => tag === undefined || record.tag === tag);
      }
    };
    Object.defineProperty(window, '__dismissPreviewWorkerNotifications', { configurable: true, value: () => {
      // dismiss every currently displayed worker notification
      for (const record of [...active.values()]) remove(record, 'dismissed');
    } });
    Object.defineProperty(window, '__previewWorkerSnapshot', { configurable: true, value: () => ({
      active: [...active.values()].map(({ title, tag, data }) => ({ title, tag, data })),
      shows: shows.map(record => ({ ...record })),
      removed: removed.map(record => ({ ...record })),
      getNotifications
    }) });
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => registration, ready: Promise.resolve(registration), register: async () => registration } });
  }, consoleOrigin);
};

// read parent-only provider calls
const providerState = (page: Page) => page.evaluate(() => (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState);

// render standard-api controls inside one managed preview document
const managedPreview = (path: string) => `<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body>
  <main>Managed permission preview <span id="path">${path}</span></main>
  <button id="get">Get location</button><output id="get-result">idle</output>
  <button id="watch">Watch location</button><button id="clear">Clear watch</button><output id="watch-result">idle</output>
  <button id="permission">Request notifications</button><output id="permission-result">idle</output>
  <button id="show">Show notification</button><button id="close">Close notification</button><output id="notification-result">idle</output>
  <button id="navigate">Navigate preview</button>
  <script>
    let watchId;
    let notice;
    const watchEvents = [];
    const locationError = error => 'error:' + error.code + ':' + error.message;
    document.querySelector('#get').onclick = () => navigator.geolocation.getCurrentPosition(
      position => { document.querySelector('#get-result').textContent = 'ok:' + position.coords.latitude.toFixed(4) + ',' + position.coords.longitude.toFixed(4) + ':' + position.coords.accuracy; },
      error => { document.querySelector('#get-result').textContent = locationError(error); }
    );
    document.querySelector('#watch').onclick = () => {
      watchId = navigator.geolocation.watchPosition(
        position => { watchEvents.push(position.coords.latitude.toFixed(4) + ',' + position.coords.longitude.toFixed(4)); document.querySelector('#watch-result').textContent = 'ok:' + watchEvents.join('|'); },
        error => { document.querySelector('#watch-result').textContent = locationError(error); }
      );
      document.querySelector('#watch-result').textContent = 'watching';
    };
    document.querySelector('#clear').onclick = () => { navigator.geolocation.clearWatch(watchId); document.querySelector('#watch-result').textContent += ':cleared'; };
    document.querySelector('#permission').onclick = async () => {
      try { document.querySelector('#permission-result').textContent = await Notification.requestPermission(); }
      catch (error) { document.querySelector('#permission-result').textContent = 'error:' + error.name; }
    };
    document.querySelector('#show').onclick = () => {
      try {
        notice = new Notification('Build complete', { body: 'Preview task finished', tag: 'preview-build' });
        document.querySelector('#notification-result').textContent = 'created';
        notice.addEventListener('show', () => { document.querySelector('#notification-result').textContent += ':show'; });
        notice.addEventListener('close', () => { document.querySelector('#notification-result').textContent += ':close'; });
      } catch (error) { document.querySelector('#notification-result').textContent = 'error:' + error.name; }
    };
    document.querySelector('#close').onclick = () => { notice?.close(); };
    document.querySelector('#navigate').onclick = () => { location.assign(location.pathname === '/next' ? '/third' : '/next'); };
  </script>
</body></html>`;

// send one valid-looking request from a nested non-owner window
const spoofPreview = `<script>window.top.postMessage({ type: 'rac-browser-permission-request', clientId: crypto.randomUUID(), id: crypto.randomUUID(), operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30000, maximumAge: 0 } }, '${consoleOrigin}')</script>`;

// load the production bridge before retaining the forged nested request
const nestedBridgeSpoofPreview = `<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body>
  <main>Nested proxied project document</main>
  ${spoofPreview}
</body></html>`;

// render native controls without the managed bridge
const directPreview = `<!doctype html><html><body>
  <main>Direct permission preview</main>
  <button id="get">Get direct location</button><output id="get-result">idle</output>
  <button id="permission">Request direct notifications</button><output id="permission-result">idle</output>
  <script>
    document.querySelector('#get').onclick = () => navigator.geolocation.getCurrentPosition(
      () => { document.querySelector('#get-result').textContent = 'unexpected-success'; },
      error => { document.querySelector('#get-result').textContent = 'error:' + error.code; }
    );
    document.querySelector('#permission').onclick = async () => {
      try { document.querySelector('#permission-result').textContent = await Notification.requestPermission(); }
      catch (error) { document.querySelector('#permission-result').textContent = 'error:' + error.name; }
    };
  </script>
</body></html>`;

// route one dashboard and its preview document
const setupDashboard = async (page: Page, options: { bridge: string; direct?: boolean }) => {
  const previewOrigin = options.direct === true ? directOrigin : managedOrigin;
  await installPaneMock(page);
  await page.context().route(`${previewOrigin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    // serve only managed previews with the production bridge
    if (!options.direct && requestUrl.pathname === '/__rac/browser-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: options.bridge });
    // serve one nested source spoof with the production bridge
    if (!options.direct && requestUrl.pathname === '/spoof-source') return route.fulfill({ contentType: 'text/html', body: nestedBridgeSpoofPreview });
    const target = requestUrl.pathname === '/__rac/browser-device' ? new URL(requestUrl.searchParams.get('location') ?? '/', requestUrl.origin) : requestUrl;
    const transition = requestUrl.pathname === '/__rac/browser-device' ? `<script>history.replaceState({}, '', ${JSON.stringify(`${target.pathname}${target.search}${target.hash}`)})</script>` : '';
    return route.fulfill({ contentType: 'text/html', body: options.direct ? directPreview : `${transition}${managedPreview(target.pathname)}` });
  });
  // serve an origin-spoofing nested document for managed-frame checks
  if (!options.direct) await page.context().route(`${directOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: spoofPreview }));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    // publish an authenticated session
    if (path === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // publish one preview target
    if (path === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-permissions', sessionId: 'socket:$1', home: '/worktrees/permissions', worktreeId: 'permissions', worktreeLabel: 'Permissions', worktreeOrder: 0, title: 'Ready', projectUrl: previewOrigin, ...(options.direct ? { projectProxied: false } : {}), stack: { actions: ['start'], running: true, tunnel: true } }], projects: [] } });
    // serve the required log ticket
    if (path === '/api/agents/agent-permissions/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    // serve empty agent collections
    if (path === '/api/agents/agent-permissions/saved-prompts' || path === '/api/agents/agent-permissions/prompt-history' || path === '/api/agents/agent-permissions/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    // serve empty worktree notes
    if (path === '/api/worktrees/permissions/notes') return route.fulfill({ json: { notes: [] } });
    // disable console push setup
    if (path === '/api/push/public-key') return route.fulfill({ json: {} });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// open the configured preview in BrowserPane
const openBrowser = async (page: Page) => {
  await page.setViewportSize({ width: 1400, height: 850 });
  await page.goto('/');
  await seedPaneSize(page, 'agent-permissions', 80, 24);
  await page.getByRole('group', { name: 'Project controls' }).getByRole('button', { name: 'Stack controls: healthy' }).click();
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Browser' })).toBeVisible();
};

// select one visible permission decision
const decide = async (page: Page, name: string, decision: 'Allow once' | 'Allow for this preview session' | 'Deny') => {
  const consent = page.getByRole('dialog', { name });
  await expect(consent).toBeVisible();
  await consent.getByRole('button', { name: decision, exact: true }).click();
  await expect(consent).toBeHidden();
};

type PermissionProtocolResponse = { clientId?: string; id: string; status: string; error?: { code?: number; message?: string }; position?: unknown };

// create one canonical deterministic protocol id
const protocolId = (prefix: string, index: number) => `${prefix}-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;

// make managed preview documents reconnect with one known client nonce
const installPermissionClientId = (context: BrowserContext, clientId: string) => context.addInitScript(({ origin, client }) => {
  // leave parent and unrelated frames unchanged
  if (location.origin !== origin) return;
  let sequence = 1;
  Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => sequence++ === 1 ? client : `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}` });
}, { origin: managedOrigin, client: clientId });

// capture broker responses inside the owning managed frame
const startPermissionResponseCapture = (preview: FrameLocator) => preview.locator('body').evaluate(() => {
  const record = window as typeof window & { __permissionResponses?: PermissionProtocolResponse[] };
  record.__permissionResponses = [];
  window.addEventListener('message', event => {
    // retain only broker responses
    if (event.data?.type === 'rac-browser-permission-response') record.__permissionResponses?.push(event.data);
  });
});

// send one trusted-frame protocol request
const postPermissionRequest = (preview: FrameLocator, message: Record<string, unknown>) => preview.locator('body').evaluate((_, { payload, target }) => window.parent.postMessage(payload, target), { payload: message, target: consoleOrigin });

// send ordered trusted-frame protocol requests in one task
const postPermissionRequests = (preview: FrameLocator, messages: Array<Record<string, unknown>>) => preview.locator('body').evaluate((_, { payloads, target }) => {
  // retain request order at the message boundary
  for (const payload of payloads) window.parent.postMessage(payload, target);
}, { payloads: messages, target: consoleOrigin });

// read the captured response stream
const permissionResponses = (preview: FrameLocator) => preview.locator('body').evaluate(() => (window as typeof window & { __permissionResponses: PermissionProtocolResponse[] }).__permissionResponses);

test('brokers geolocation only after consent and revokes watches across preview lifetimes', async ({ context, page }) => {
  test.setTimeout(75_000);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consentName = 'Allow location?';

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: consentName })).toContainText(managedOrigin);
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, consentName, 'Deny');
  await expect(preview.locator('#get-result')).toHaveText(/^error:1:/u);
  expect((await providerState(page)).geolocationGets).toBe(0);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');

  await preview.getByRole('button', { name: 'Get location' }).click();
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, consentName, 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  expect((await providerState(page)).geolocationGets).toBe(1);

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, consentName, 'Allow for this preview session');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(3);

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(preview.locator('#watch-result')).toContainText('47.6062,-122.3321');
  await context.setGeolocation({ latitude: 37.7749, longitude: -122.4194, accuracy: 8 });
  await expect(preview.locator('#watch-result')).toContainText('37.7749,-122.4194');
  await preview.getByRole('button', { name: 'Clear watch' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(1);
  const clearedOutput = await preview.locator('#watch-result').textContent();
  await context.setGeolocation({ latitude: 40.7128, longitude: -74.0060, accuracy: 6 });
  await page.waitForTimeout(250);
  await expect(preview.locator('#watch-result')).toHaveText(clearedOutput ?? '');

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(2);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/third');
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(2);
  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: consentName })).toBeVisible();
  expect((await providerState(page)).geolocationGets).toBe(3);

  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  expect((await providerState(page)).geolocationGets).toBe(3);

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await decide(page, consentName, 'Allow for this preview session');
  await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(3);
  const clearCount = (await providerState(page)).geolocationClears.length;
  await page.getByRole('dialog', { name: 'Browser' }).getByRole('button', { name: 'Close browser' }).click();
  await expect.poll(async () => (await providerState(page)).geolocationClears.length).toBe(clearCount + 1);
});

test('restores managed permission forwarding after external navigation returns Home', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const browser = page.getByRole('dialog', { name: 'Browser' });
  const frame = page.locator('iframe[title="Project browser"]');
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await expect(frame).toHaveAttribute('name', managedFrameName);
  await browser.getByRole('textbox', { name: 'Browser address' }).fill(`${directOrigin}/away`);
  await browser.getByRole('textbox', { name: 'Browser address' }).press('Enter');
  await expect(frame).toHaveAttribute('src', `${directOrigin}/away`);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);

  await browser.getByRole('button', { name: 'Go to project home' }).click();
  await expect(preview.getByText('Managed permission preview')).toBeVisible();
  await expect(frame).toHaveAttribute('name', managedFrameName);
  await expect.poll(async () => await preview.locator('body').evaluate(() => window.name)).toBe(managedFrameName);
  await preview.getByRole('button', { name: 'Get location' }).click();
  expect((await providerState(page)).geolocationGets).toBe(0);
  await decide(page, 'Allow location?', 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  expect((await providerState(page)).geolocationGets).toBe(1);
});

test('releases denied native watches so later preview watches keep their capacity', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    let nextWatchId = 100;
    Object.defineProperties(navigator.geolocation, {
      watchPosition: {
        configurable: true,
        // deny one native watch after allocating its id
        value: (_success: PositionCallback, failure?: PositionErrorCallback | null) => {
          state.geolocationWatches += 1;
          const watchId = nextWatchId;
          nextWatchId += 1;
          queueMicrotask(() => failure?.({ code: 1, message: 'native location denied', PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }));
          return watchId;
        }
      },
      clearWatch: {
        configurable: true,
        // retain every denied watcher release
        value: (watchId: number) => { state.geolocationClears.push(watchId); }
      }
    });
  });

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await decide(page, 'Allow location?', 'Allow for this preview session');
  await expect(preview.locator('#watch-result')).toHaveText(/^error:1:/u);
  // exceed the eight-watch cap through sequential native denials
  for (let index = 2; index <= 9; index += 1) {
    await preview.getByRole('button', { name: 'Watch location' }).click();
    await expect(preview.locator('#watch-result')).toHaveText(/^error:1:/u);
    await expect.poll(async () => (await providerState(page)).geolocationWatches).toBe(index);
  }
  await expect.poll(async () => (await providerState(page)).geolocationClears).toEqual([100, 101, 102, 103, 104, 105, 106, 107, 108]);
});

test('keeps stale same-id geolocation callbacks from escaping a replacement document clear', async ({ context, page }) => {
  const clientId = '00000000-0000-4000-8000-000000000001';
  const requestId = '00000000-0000-4000-8000-000000000010';
  const clearId = '00000000-0000-4000-8000-000000000011';
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    Object.defineProperty(window, '__releasePermissionPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6 + index, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain callbacks across preview document replacement
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);

  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(1);
  await preview.getByRole('button', { name: 'Navigate preview' }).click();
  await expect(preview.locator('#path')).toHaveText('/next');
  await startPermissionResponseCapture(preview);

  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(2);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: clearId, operation: 'geolocation-clear', watchId: requestId });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: clearId, status: 'ok' }));

  await page.evaluate(() => {
    const release = (window as typeof window & { __releasePermissionPosition: (index: number) => void }).__releasePermissionPosition;
    // deliver the stale callback before the cancelled replacement callback
    release(0);
    release(1);
  });
  await page.waitForTimeout(100);
  const positionResponses = (await permissionResponses(preview)).filter(response => response.id === requestId && response.position !== undefined);
  expect(positionResponses).toEqual([]);
});

test('keeps parent capability capacity bounded across document replacement', async ({ context, page }) => {
  test.setTimeout(60_000);
  const requestId = protocolId('40000000', 100);
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.geolocationGets = 0;
    Object.defineProperty(window, '__releaseParentCapacityPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6 + index, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain native callbacks beyond document replacement
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);
  const connectDocument = async (index: number) => {
    const clientId = protocolId('41000000', index);
    const connectId = protocolId('42000000', index);
    await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: connectId, operation: 'connect' });
    await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId, id: connectId, status: 'ok' }));
    return clientId;
  };
  // fill the parent-wide native capacity across replacement documents
  for (let index = 1; index <= 16; index += 1) {
    const clientId = await connectDocument(index);
    await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
    await decide(page, 'Allow location?', 'Allow once');
  }
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(16);

  const overflowClient = await connectDocument(17);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: overflowClient, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId: overflowClient, id: requestId, status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  expect((await providerState(page)).geolocationGets).toBe(16);

  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(0));
  const currentClient = await connectDocument(18);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: currentClient, id: requestId, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } });
  await decide(page, 'Allow location?', 'Allow once');
  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(17);

  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(1));
  const clearId = protocolId('43000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId: currentClient, id: clearId, operation: 'geolocation-clear', watchId: requestId });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ clientId: currentClient, id: clearId, status: 'ok' }));
  await page.evaluate(() => (window as typeof window & { __releaseParentCapacityPosition: (index: number) => void }).__releaseParentCapacityPosition(16));
  await page.waitForTimeout(100);
  expect((await permissionResponses(preview)).some(response => response.clientId === currentClient && response.id === requestId && response.position !== undefined)).toBe(false);
});

test('bounds native location work while preserving clear through saturated replay history', async ({ context, page }) => {
  const clientId = protocolId('20000000', 1);
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'Allow for this preview session');
  await expect(preview.locator('#get-result')).toHaveText('ok:47.6062,-122.3321:12');
  await page.evaluate(() => {
    const callbacks: PositionCallback[] = [];
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.geolocationGets = 0;
    Object.defineProperty(window, '__releaseCapacityPosition', { configurable: true, value: (index: number) => callbacks[index]?.({ coords: { latitude: 47.6, longitude: -122.3, accuracy: 5, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() } as GeolocationPosition) });
    Object.defineProperty(navigator.geolocation, 'getCurrentPosition', {
      configurable: true,
      // retain native work until the test releases it
      value: (success: PositionCallback) => { state.geolocationGets += 1; callbacks.push(success); }
    });
  });
  await startPermissionResponseCapture(preview);
  const requestIds = Array.from({ length: 140 }, (_, index) => protocolId('21000000', index + 1));
  await postPermissionRequests(preview, requestIds.map(id => ({ type: 'rac-browser-permission-request', clientId, id, operation: 'geolocation-get', options: { enableHighAccuracy: false, timeout: 30_000, maximumAge: 0 } })));

  await expect.poll(async () => (await providerState(page)).geolocationGets).toBe(16);
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds[16], status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  const clearId = protocolId('22000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: clearId, operation: 'geolocation-clear', watchId: requestIds[0] });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: clearId, status: 'ok', watchId: requestIds[0] }));
  await page.evaluate(() => (window as typeof window & { __releaseCapacityPosition: (index: number) => void }).__releaseCapacityPosition(0));
  await page.waitForTimeout(100);
  expect((await permissionResponses(preview)).some(response => response.id === requestIds[0] && response.position !== undefined)).toBe(false);
});

test('bounds native notification prompts while preserving close through saturated replay history', async ({ context, page }) => {
  const clientId = protocolId('30000000', 1);
  await installParentProviders(context);
  await installPermissionClientId(context, clientId);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    state.notificationRequests = [];
    // hold the native prompt open until teardown
    Notification.requestPermission = () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); return new Promise<NotificationPermission>(() => undefined); };
  });
  await startPermissionResponseCapture(preview);
  const requestIds = Array.from({ length: 140 }, (_, index) => protocolId('31000000', index + 1));
  const notificationRequest = (id: string) => ({ type: 'rac-browser-permission-request', clientId, id, operation: 'notification-permission' });
  await postPermissionRequests(preview, requestIds.slice(0, 16).map(notificationRequest));
  await decide(page, 'Allow notifications?', 'Allow for this preview session');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await postPermissionRequest(preview, notificationRequest(requestIds[16]));
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds[16], status: 'error', error: { code: 2, message: 'Too many active permission operations' } }));
  await postPermissionRequests(preview, requestIds.slice(17).map(notificationRequest));
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: requestIds.at(-1), status: 'error' }));

  const closeId = protocolId('32000000', 1);
  await postPermissionRequest(preview, { type: 'rac-browser-permission-request', clientId, id: closeId, operation: 'notification-close', notificationId: requestIds[0] });
  await expect.poll(async () => await permissionResponses(preview)).toContainEqual(expect.objectContaining({ id: closeId, status: 'ok', notificationId: requestIds[0] }));
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('attributes preview notifications and preserves native click activation', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  const consentName = 'Allow notifications?';

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  const consent = page.getByRole('dialog', { name: consentName });
  await expect(consent).toContainText(`${managedOrigin} wants Remote Agent Console to show notifications for this preview.`);
  await expect(consent).toContainText('Notifications identify this preview and are displayed by Remote Agent Console.');
  await expect(consent).not.toContainText(/service worker|push/iu);
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-desktop.png', fullPage: true });
  const split = page.locator('.log-split');
  const splitSizing = await split.evaluate(element => {
    const layout = element as HTMLElement;
    const previous = { minimum: layout.style.getPropertyValue('--split-pane-min-width'), browser: layout.style.getPropertyValue('--browser-split') };
    layout.style.setProperty('--split-pane-min-width', '300px');
    layout.style.setProperty('--browser-split', '300px');
    return previous;
  });
  await expect.poll(async () => (await page.getByRole('dialog', { name: 'Browser' }).boundingBox())?.width ?? 0).toBeLessThanOrEqual(301);
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-narrow-desktop.png', fullPage: true });
  const narrowLayout = await consent.evaluate(element => {
    const consentBounds = element.getBoundingClientRect();
    const buttons = [...element.querySelectorAll('button')].map(button => button.getBoundingClientRect());
    return { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, buttonOverflow: buttons.some(bounds => bounds.left < consentBounds.left || bounds.right > consentBounds.right) };
  });
  expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.clientWidth);
  expect(narrowLayout.buttonOverflow).toBe(false);
  await split.evaluate((element, previous) => {
    const layout = element as HTMLElement;
    layout.style.setProperty('--split-pane-min-width', previous.minimum);
    layout.style.setProperty('--browser-split', previous.browser);
  }, splitSizing);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(consent).toBeVisible();
  await page.screenshot({ path: '/tmp/remoteagents-browser-permission-consent-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1400, height: 850 });
  expect((await providerState(page)).notificationRequests).toEqual([]);
  await decide(page, consentName, 'Allow for this preview session');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText('created:show');
  await expect.poll(async () => (await providerState(page)).notifications).toEqual([{ title: `Preview ${managedOrigin} — Build complete`, body: 'Shown by Remote Agent Console\n\nPreview task finished', closed: false }]);
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText(':close');
  await expect.poll(async () => (await providerState(page)).notifications[0]?.closed).toBe(true);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await expect(page.getByRole('dialog', { name: consentName })).toBeHidden();
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('preserves a dismissed native notification prompt as default until explicit denial', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await page.evaluate(() => {
    const state = (window as typeof window & { __permissionProviderState: ProviderState }).__permissionProviderState;
    // emulate dismissing the native permission surface
    Notification.requestPermission = async () => { state.notificationRequests.push({ active: navigator.userActivation.isActive }); return 'default'; };
  });

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('default');
  await expect.poll(async () => await preview.locator('body').evaluate(() => Notification.permission)).toBe('default');
  expect((await providerState(page)).notificationRequests).toEqual([{ active: true }]);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Deny');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  await expect.poll(async () => await preview.locator('body').evaluate(() => Notification.permission)).toBe('denied');
  expect((await providerState(page)).notificationRequests).toHaveLength(1);
});

test('rejects spoofed permission requests and leaves direct frames unbrokered', async ({ context, page }) => {
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge, direct: true });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await page.evaluate(() => window.postMessage({ type: 'rac-browser-permission-request', clientId: crypto.randomUUID(), id: crypto.randomUUID(), operation: 'geolocation-get' }, '*'));
  await page.waitForTimeout(100);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);

  await preview.getByRole('button', { name: 'Get direct location' }).click();
  await expect(preview.locator('#get-result')).toHaveText(/^error:/u);
  await preview.getByRole('button', { name: 'Request direct notifications' }).click();
  await expect(preview.locator('#permission-result')).toHaveText(/^(?:denied|error:)/u);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
  expect((await providerState(page)).geolocationGets).toBe(0);
  expect((await providerState(page)).notificationRequests).toEqual([]);
});

test('rejects correct-origin and foreign-origin requests from nested preview windows', async ({ context, page }) => {
  await installParentProviders(context);
  await installNativePermissionReferenceCapture(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.locator('body').evaluate((body, frameName) => {
    const sameOrigin = document.createElement('iframe');
    sameOrigin.src = '/spoof-source';
    sameOrigin.name = frameName;
    const foreignOrigin = document.createElement('iframe');
    foreignOrigin.src = 'https://external-preview.example/spoof-origin';
    body.append(sameOrigin, foreignOrigin);
  }, managedFrameName);
  await expect(preview.locator('iframe')).toHaveCount(2);
  const nested = preview.frameLocator('iframe[src="/spoof-source"]');
  await expect(nested.getByText('Nested proxied project document')).toBeVisible();
  await expect(nested.locator('script[src="/__rac/browser-bridge.js"]')).toHaveCount(1);
  expect(await nested.locator('body').evaluate(() => ({ marked: window.name, nested: window.parent !== window.top }))).toEqual({ marked: managedFrameName, nested: true });
  expect(await nativePermissionApisPreserved(nested)).toEqual({
    geolocation: true,
    getCurrentPosition: true,
    watchPosition: true,
    clearWatch: true,
    notification: true,
    notificationRequestPermission: true
  });
  await page.waitForTimeout(200);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
  expect((await providerState(page)).geolocationGets).toBe(0);
  expect((await providerState(page)).notificationRequests).toEqual([]);
});

test('preserves native apis in an unnamed proxied frame embedded outside RAC', async ({ context, page }) => {
  await installNativePermissionReferenceCapture(context);
  const bridge = await projectBrowserBridge();
  await context.route(`${managedOrigin}/**`, async route => {
    const requestUrl = new URL(route.request().url());
    // serve the production bridge from its managed endpoint
    if (requestUrl.pathname === '/__rac/browser-bridge.js') return route.fulfill({ contentType: 'text/javascript', body: bridge });
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><script src="/__rac/browser-bridge.js"></script></head><body><main>Standalone proxied project document</main></body></html>' });
  });
  await context.route(`${directOrigin}/**`, route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body>
    <main>Non-RAC embedding page</main>
    <iframe title="Standalone proxied project" src="${managedOrigin}/standalone"></iframe>
    <script>window.__permissionMessages = []; window.addEventListener('message', event => window.__permissionMessages.push(event.data));</script>
  </body></html>` }));

  await page.goto(`${directOrigin}/embed-proxied`);
  const standalone = page.frameLocator('iframe[title="Standalone proxied project"]');
  await expect(standalone.getByText('Standalone proxied project document')).toBeVisible();
  await expect(standalone.locator('script[src="/__rac/browser-bridge.js"]')).toHaveCount(1);
  expect(await standalone.locator('body').evaluate(() => ({ unnamed: window.name === '', directChild: window.parent === window.top }))).toEqual({ unnamed: true, directChild: true });
  expect(await nativePermissionApisPreserved(standalone)).toEqual({
    geolocation: true,
    getCurrentPosition: true,
    watchPosition: true,
    clearWatch: true,
    notification: true,
    notificationRequestPermission: true
  });
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as typeof window & { __permissionMessages: unknown[] }).__permissionMessages)).toEqual([]);
  await expect(page.locator('.browser-permission-consent')).toHaveCount(0);
});

test('cancels queued watches and transport-timed-out consent without native calls', async ({ context, page }) => {
  test.setTimeout(45_000);
  await page.clock.install();
  await installParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Watch location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeVisible();
  await preview.getByRole('button', { name: 'Clear watch' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  expect((await providerState(page)).geolocationWatches).toBe(0);

  await preview.getByRole('button', { name: 'Get location' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeVisible();
  await page.clock.fastForward(150_001);
  await expect(preview.locator('#get-result')).toHaveText(/^error:3:/u);
  await expect(page.getByRole('dialog', { name: 'Allow location?' })).toBeHidden();
  expect((await providerState(page)).geolocationGets).toBe(0);

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeHidden();
  await expect(preview.locator('#notification-result')).toHaveText('created:close');
  expect((await providerState(page)).notifications).toEqual([]);

  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeVisible();
  await page.clock.fastForward(120_001);
  await expect(page.getByRole('dialog', { name: 'Allow notifications?' })).toBeHidden();
  expect((await providerState(page)).notifications).toEqual([]);
});

test('cancels notification display while the service-worker fallback is pending', async ({ context, page }) => {
  await installServiceWorkerNotificationProvider(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow for this preview session');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  await preview.getByRole('button', { name: 'Show notification' }).click();
  await expect(preview.locator('#notification-result')).toHaveText('created');
  await preview.getByRole('button', { name: 'Close notification' }).click();
  await expect(preview.locator('#notification-result')).toContainText(':close');
  await page.evaluate(() => (window as typeof window & { __resolvePreviewRegistration: () => void }).__resolvePreviewRegistration());
  await page.waitForTimeout(100);
  expect((await providerState(page)).notifications).toEqual([]);
});

test('reconciles dismissed and replaced worker notifications beyond the live owner cap', async ({ context, page }) => {
  test.setTimeout(60_000);
  await installReconcilingWorkerProvider(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow for this preview session');
  await expect(preview.locator('#permission-result')).toHaveText('granted');
  const show = (index: number, tag: string) => preview.locator('body').evaluate((_, input) => new Promise<'show' | 'error'>(resolve => {
    const record = window as typeof window & { __capacityNotifications?: Notification[] };
    const notification = new Notification(`Worker notice ${input.index}`, { body: `body ${input.index}`, tag: input.tag });
    record.__capacityNotifications = [...record.__capacityNotifications ?? [], notification];
    notification.addEventListener('show', () => resolve('show'));
    notification.addEventListener('error', () => resolve('error'));
  }), { index, tag });
  const outcomes: Array<'show' | 'error'> = [];
  // exceed the parent cap while the os dismisses every prior display
  for (let index = 0; index < 20; index += 1) {
    outcomes.push(await show(index, `dismissed-${index}`));
    await page.evaluate(() => (window as typeof window & { __dismissPreviewWorkerNotifications: () => void }).__dismissPreviewWorkerNotifications());
  }
  // exceed the cap again while one worker tag replaces its predecessor
  for (let index = 20; index < 40; index += 1) outcomes.push(await show(index, 'shared-worker-tag'));
  expect(outcomes).toEqual(Array.from({ length: 40 }, () => 'show'));
  const snapshot = await page.evaluate(() => (window as typeof window & { __previewWorkerSnapshot: () => { active: Array<{ data?: Record<string, unknown> }>; shows: unknown[]; removed: Array<{ reason?: string }>; getNotifications: number } }).__previewWorkerSnapshot());
  expect(snapshot.shows).toHaveLength(40);
  expect(snapshot.active).toHaveLength(1);
  expect(snapshot.removed.filter(record => record.reason === 'dismissed')).toHaveLength(20);
  expect(snapshot.removed.filter(record => record.reason === 'replaced')).toHaveLength(19);
  expect(snapshot.getNotifications).toBeGreaterThanOrEqual(40);
  expect(snapshot.active[0]?.data).toEqual(expect.objectContaining({ previewOwnerId: expect.any(String), previewClientId: expect.any(String), previewNotificationId: expect.any(String) }));
});

test('returns clean denials when parent browser capabilities are unavailable', async ({ context, page }) => {
  const pageErrors: string[] = [];
  // retain unexpected top-level failures
  page.on('pageerror', error => pageErrors.push(error.message));
  await installUnsupportedParentProviders(context);
  const bridge = await projectBrowserBridge();
  await setupDashboard(page, { bridge });
  await openBrowser(page);
  const preview = page.frameLocator('iframe[title="Project browser"]');

  await preview.getByRole('button', { name: 'Get location' }).click();
  await decide(page, 'Allow location?', 'Allow once');
  await expect(preview.locator('#get-result')).toHaveText(/^error:\d+:/u);
  await preview.getByRole('button', { name: 'Request notifications' }).click();
  await decide(page, 'Allow notifications?', 'Allow once');
  await expect(preview.locator('#permission-result')).toHaveText('denied');
  expect(pageErrors).toEqual([]);
});
