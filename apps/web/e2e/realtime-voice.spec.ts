import { expect, test } from '@playwright/test';

test('opens Davo with the selected canonical context', async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open every fixture socket asynchronously
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close one fixture socket
      close() { this.readyState = MockWebSocket.CLOSED; this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  let realtimeHeaders: Record<string, string> = {};
  let realtimeBody: unknown;
  let renamedClient: unknown;
  let renamedServer: unknown;
  let updateStarted = false;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'voice-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // persist one renamed client
    if (url.pathname === '/api/auth/device-name') {
      renamedClient = request.postDataJSON();
      return route.fulfill({ json: { csrfToken: 'voice-csrf', active: true, deviceName: 'Office Mac', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    }
    // persist one renamed server
    if (url.pathname === '/api/server/name') {
      renamedServer = request.postDataJSON();
      return route.fulfill({ json: { name: 'Garage Server', server: { name: 'Garage Server', url: 'https://framework.santosa.dev', remotes: [] } } });
    }
    // launch one host update
    if (url.pathname === '/api/server/update' && request.method() === 'POST') {
      updateStarted = true;
      return route.fulfill({ status: 202, json: { id: 'server_update_operation_1234', kind: 'update', state: 'queued' } });
    }
    // retain the progress state
    if (url.pathname === '/api/server/update/server_update_operation_1234') return route.fulfill({ json: { id: 'server_update_operation_1234', kind: 'update', state: 'running' } });
    // provide one selected agent and worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], worktrees: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/queued-prompts') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/prompt-history') return route.fulfill({ json: { prompts: [] } });
    if (url.pathname === '/api/agents/agent-cora/skills') return route.fulfill({ json: { skills: [] } });
    if (url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { notes: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // capture the selected context before simulating missing provider setup
    if (url.pathname === '/api/realtime/session') {
      realtimeHeaders = request.headers();
      realtimeBody = request.postDataJSON();
      return route.fulfill({ status: 503, json: { error: 'Realtime voice is unavailable.' } });
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  const settings = page.getByRole('button', { name: 'Global settings' });
  await expect(page.locator('.output-server-switcher > :last-child').getByRole('button', { name: 'Global settings' })).toBeVisible();
  await expect(settings).toHaveText('⋮');
  await expect.poll(() => settings.evaluate(button => { const box = button.getBoundingClientRect(); return Math.abs(box.width - box.height); })).toBeLessThanOrEqual(1);
  await settings.click();
  await expect(page.getByRole('menu', { name: 'Global settings' }).getByRole('menuitem')).toHaveText(['Rename Client', 'Rename Server', 'Update Server']);
  await page.getByRole('menuitem', { name: 'Rename Client' }).click();
  await expect(page.getByRole('menu', { name: 'Global settings' })).toHaveCount(0);
  const renameDialog = page.getByRole('dialog', { name: 'Rename Client' });
  await expect(renameDialog).toBeVisible();
  await renameDialog.getByLabel('Client name').fill('Office Mac');
  await renameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(renameDialog).toHaveCount(0);
  expect(renamedClient).toEqual({ deviceName: 'Office Mac' });
  await settings.click();
  await page.getByRole('menuitem', { name: 'Rename Server' }).click();
  const serverRenameDialog = page.getByRole('dialog', { name: 'Rename Server' });
  await serverRenameDialog.getByLabel('Server name').fill('Garage Server');
  await serverRenameDialog.getByRole('button', { name: 'Save' }).click();
  await expect(serverRenameDialog).toHaveCount(0);
  expect(renamedServer).toEqual({ name: 'Garage Server' });
  const callTrigger = page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' });
  await expect(page.locator('.output-server-switcher > button').first()).toHaveAttribute('aria-label', 'Call Davo');
  await expect(callTrigger.locator('svg')).toHaveCount(1);
  await callTrigger.click();
  await expect(page.getByRole('heading', { name: 'Davo' })).toBeVisible();
  await expect(page.locator('.voice-context')).toHaveText(/Garage Server.*Active: Cora.*Cora/u);
  await expect(page.locator('.voice-dialog').getByRole('alert')).toHaveText('Davo is not configured on this server.');
  expect(realtimeHeaders['x-csrf-token']).toBe('voice-csrf');
  expect(realtimeBody).toMatchObject({ worktreeId: 'cora', agentId: 'agent-cora', voiceSessionId: expect.any(String) });
  await settings.click();
  await page.getByRole('menuitem', { name: 'Update Server' }).click();
  const updateDialog = page.getByRole('dialog', { name: 'Update Server' });
  await updateDialog.getByRole('button', { name: 'Update Server', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Updating Server' })).toContainText('Pulling, rebuilding, and restarting…');
  expect(updateStarted).toBe(true);
});

test('mobile swaps between an ongoing Davo call and the main UI', async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open every fixture socket asynchronously
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close one fixture socket
      close() { this.onclose?.(new CloseEvent('close')); }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  let releaseCredential!: () => void;
  const credentialRelease = new Promise<void>(resolve => { releaseCredential = resolve; });
  let credentialRequested!: () => void;
  const credentialRequest = new Promise<void>(resolve => { credentialRequested = resolve; });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    // restore one authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'voice-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // provide one selected agent and worktree
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', title: 'Ready', unread: false }], worktrees: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/saved-prompts' || url.pathname === '/api/agents/agent-cora/queued-prompts' || url.pathname === '/api/agents/agent-cora/prompt-history' || url.pathname === '/api/agents/agent-cora/skills' || url.pathname === '/api/worktrees/cora/notes') return route.fulfill({ json: { prompts: [], skills: [], notes: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    if (url.pathname === '/api/realtime/session') {
      credentialRequested();
      await credentialRelease;
      return route.fulfill({ json: { ok: true, clientSecret: { value: 'ek_testcredential' }, model: 'gpt-realtime-2.1' } }).catch(() => undefined);
    }
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' }).click();
  await credentialRequest;
  const ongoingCall = page.getByRole('button', { name: 'Ongoing Davo call', exact: true });
  await expect(ongoingCall).toHaveAttribute('aria-pressed', 'true');
  await expect(ongoingCall.locator('span')).toHaveText('Ongoing');
  expect(await ongoingCall.evaluate(element => getComputedStyle(element).color)).toBe('rgb(166, 227, 161)');
  await page.getByRole('button', { name: 'Ongoing Davo call — show main UI' }).click();
  await expect(page.getByRole('heading', { name: 'Davo' })).toHaveCount(0);
  const hiddenCall = page.getByRole('button', { name: 'Show ongoing Davo call' });
  await expect(hiddenCall).toHaveAttribute('aria-pressed', 'false');
  await expect(hiddenCall).toHaveClass(/active/u);
  await hiddenCall.click();
  await expect(page.getByRole('heading', { name: 'Davo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Calling...' })).toBeVisible();
  releaseCredential();
});

test('waits for MCP tools and requests a spoken follow-up after tool completion', async ({ page }) => {
  await page.addInitScript(() => {
    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      readyState = MockWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      // open every fixture socket asynchronously
      constructor(_url: string | URL) { window.setTimeout(() => { this.readyState = MockWebSocket.OPEN; this.onopen?.(new Event('open')); }); }
      // ignore fixture writes
      send() {}
      // close one fixture socket
      close() { this.onclose?.(new CloseEvent('close')); }
    }
    class MockDataChannel extends EventTarget {
      readyState: RTCDataChannelState = 'open';
      readonly sent: string[] = [];
      // retain client events for assertions
      send(value: string) { this.sent.push(value); }
      // close the fixture channel
      close() { this.readyState = 'closed'; }
    }
    const audioTrack = { enabled: true, stop: () => undefined };
    const media = { getTracks: () => [audioTrack], getAudioTracks: () => [audioTrack] } as unknown as MediaStream;
    class MockPeerConnection extends EventTarget {
      connectionState: RTCPeerConnectionState = 'new';
      ontrack: ((event: RTCTrackEvent) => void) | null = null;
      // expose one inspectable provider channel
      createDataChannel() {
        const data = new MockDataChannel();
        (window as unknown as { davoChannel?: MockDataChannel }).davoChannel = data;
        window.setTimeout(() => data.dispatchEvent(new Event('open')));
        return data as unknown as RTCDataChannel;
      }
      // accept the fixture microphone track
      addTrack() { return {} as RTCRtpSender; }
      // return one fixture offer
      async createOffer() { return { type: 'offer' as const, sdp: 'fixture-offer' }; }
      // accept fixture descriptions
      async setLocalDescription() {}
      async setRemoteDescription() {}
      // close the fixture peer
      close() { this.connectionState = 'closed'; }
    }
    Object.defineProperty(window, 'WebSocket', { configurable: true, value: MockWebSocket });
    Object.defineProperty(window, 'RTCPeerConnection', { configurable: true, value: MockPeerConnection });
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => media } });
    const play = HTMLMediaElement.prototype.play;
    // count hang-up playback without requiring an audio device
    HTMLMediaElement.prototype.play = function () {
      // intercept only Davo's disconnect sound
      if (this.classList.contains('voice-hangup-sound')) {
        (window as unknown as { davoHangupPlays?: number }).davoHangupPlays = ((window as unknown as { davoHangupPlays?: number }).davoHangupPlays ?? 0) + 1;
        return Promise.resolve();
      }
      return play.call(this);
    };
    (window as unknown as { davoTrack?: typeof audioTrack }).davoTrack = audioTrack;
  });
  await page.route('https://api.openai.com/v1/realtime/calls?**', route => route.fulfill({ status: 200, body: 'fixture-answer' }));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // restore one authenticated browser session
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'voice-csrf', active: true, deviceName: 'Test device', server: { name: 'Framework', url: 'https://framework.santosa.dev', remotes: [] } } });
    // provide two selectable active worktrees
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-cora', paneId: '%1', sessionId: 'socket:$1', socketFingerprint: 'socket', workspace: '/worktrees/cora', worktreeId: 'cora', worktreeLabel: 'Cora', worktreeOrder: 1, title: 'Ready', unread: false }, { id: 'agent-ferry', paneId: '%2', sessionId: 'socket:$2', socketFingerprint: 'socket', workspace: '/worktrees/ferry-fyi', worktreeId: 'ferry-fyi', worktreeLabel: 'Ferry FYI', worktreeOrder: 2, title: 'Ready', unread: false }], worktrees: [], cleanupPending: 0, reviews: [], reviewTour: { available: false, reason: 'generator_unavailable' } } });
    if (url.pathname === '/api/dashboard/ticket') return route.fulfill({ json: { ticket: 'dashboard-ticket' } });
    if (url.pathname === '/api/agents/agent-cora/tickets' || url.pathname === '/api/agents/agent-ferry/tickets') return route.fulfill({ json: { ticket: 'log-ticket' } });
    if (/^\/api\/agents\/(?:agent-cora|agent-ferry)\/(?:saved-prompts|queued-prompts|prompt-history|skills)$/u.test(url.pathname) || /^\/api\/worktrees\/(?:cora|ferry-fyi)\/notes$/u.test(url.pathname)) return route.fulfill({ json: { prompts: [], skills: [], notes: [] } });
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide one browser-safe provider credential
    if (url.pathname === '/api/realtime/session') return route.fulfill({ json: { ok: true, clientSecret: { value: 'ek_fixturecredential' }, model: 'gpt-realtime-2.1' } });
    if (url.pathname === '/api/realtime/session/heartbeat' || url.pathname === '/api/realtime/session/stop') return route.fulfill({ json: { ok: true } });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });

  await page.goto('/');
  await page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' }).click();
  const calling = page.getByRole('button', { name: 'Calling...' });
  await expect(calling).toBeVisible();
  await expect(page.locator('.output-server-switcher .server-switcher-voice')).toBeHidden();
  // keep Davo at phone width beside the usable desktop UI
  const split = await page.evaluate(() => {
    const voice = document.querySelector<HTMLElement>('.voice-dialog')?.getBoundingClientRect();
    const panel = document.querySelector<HTMLElement>('.console > .panel')?.getBoundingClientRect();
    const output = document.querySelector<HTMLElement>('.log')?.getBoundingClientRect();
    const buttons = document.querySelector<HTMLElement>('.output-server-switcher')?.getBoundingClientRect();
    return { voiceLeft: voice?.left, voiceRight: voice?.right, voiceWidth: voice?.width, panelLeft: panel?.left, outputLeft: output?.left, outputRight: output?.right, buttonsLeft: buttons?.left, viewportWidth: window.innerWidth };
  });
  expect(split.voiceLeft).toBe(0);
  expect(split.voiceWidth).toBe(390);
  expect(split.panelLeft).toBe(split.voiceRight);
  expect(split.outputLeft).toBe(split.voiceRight);
  expect(split.outputRight).toBe(split.viewportWidth);
  expect(split.buttonsLeft).toBeGreaterThan(split.voiceRight ?? 0);
  await expect(page.getByLabel('Live log')).toBeVisible();
  // verify centered symmetric call controls
  const callButtonStyle = await calling.evaluate(button => { const style = getComputedStyle(button); return { left: style.paddingLeft, right: style.paddingRight, alignment: style.justifyContent }; });
  expect(callButtonStyle.left).toBe(callButtonStyle.right);
  expect(callButtonStyle.alignment).toBe('center');
  expect(await page.locator('audio.voice-ringing').evaluate(audio => ({ autoplay: (audio as HTMLAudioElement).autoplay, loop: (audio as HTMLAudioElement).loop, source: (audio as HTMLAudioElement).getAttribute('src') }))).toEqual({ autoplay: true, loop: true, source: '/davo-ring.wav' });
  await expect(page.getByText('Loading Davo tools…')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(false);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed' }) })));
  await expect(page.getByRole('button', { name: 'Hang up' })).toBeVisible();
  await expect(page.locator('audio.voice-ringing')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(true);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string; response?: { instructions?: string; tools?: unknown[] } }).find(value => value.type === 'response.create'))).toMatchObject({ response: { instructions: expect.stringMatching(/Ansel.*active worktree is Cora/u), tools: [] } });
  const mute = page.getByRole('button', { name: 'Mute' });
  await mute.click();
  await expect(page.getByRole('button', { name: 'Unmute' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Hang up' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(false);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) })));
  await expect.poll(() => page.evaluate(() => Number(getComputedStyle(document.documentElement).getPropertyValue('--davo-input-level')))).toBe(0);
  await page.getByRole('button', { name: 'Unmute' }).click();
  await expect(mute).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => (window as unknown as { davoTrack: { enabled: boolean } }).davoTrack.enabled)).toBe(true);
  await expect(page.locator('.voice-soundwave i')).toHaveCount(56);
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_started' }) }));
  });
  const voiceSurface = page.locator('.voice-dialog > div');
  await expect.poll(() => voiceSurface.evaluate(element => Number(element.style.getPropertyValue('--davo-level')))).toBeGreaterThan(.2);
  await expect.poll(() => voiceSurface.evaluate(element => Number(element.style.getPropertyValue('--mic-level')))).toBeGreaterThan(.17);
  await expect.poll(() => page.locator('.voice-soundwave.davo').evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.2);
  await expect.poll(() => page.locator('.voice-soundwave.mic').evaluate(element => Number(getComputedStyle(element).opacity))).toBeGreaterThan(.17);
  const waveEdges = await page.evaluate(() => ({ davo: document.querySelector<HTMLElement>('.voice-soundwave.davo')?.getBoundingClientRect().left, mic: document.querySelector<HTMLElement>('.voice-soundwave.mic')?.getBoundingClientRect().right, surface: document.querySelector<HTMLElement>('.voice-dialog > div')?.getBoundingClientRect() }));
  expect(waveEdges.davo).toBeLessThan(waveEdges.surface?.left ?? 0);
  expect(waveEdges.mic).toBeGreaterThan(waveEdges.surface?.right ?? 0);
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'input_audio_buffer.speech_stopped' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped' }) }));
  });
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'unintelligible-1', delta: 'Unclear partial' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'unintelligible-1', error: { code: 'audio_unintelligible' } }) }));
  });
  await expect(page.getByText('Unclear partial')).toHaveCount(0);
  await expect(page.locator('.voice-dialog').getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken-1', delta: 'Give me ' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'spoken-1', delta: 'a sitrep' }) }));
  });
  await expect(page.locator('.voice-user > span')).toHaveText('Give me a sitrep');
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'spoken-1', transcript: 'Give me a sitrep, please.' }) })));
  await expect(page.locator('.voice-user > span')).toHaveText('Give me a sitrep, please.');
  await expect(page.locator('.voice-user')).toHaveCount(1);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.mcp_call.completed', name: 'list_instances' }) })));
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string }).filter(value => value.type === 'response.create').length)).toBe(2);
  // switch Davo and the browser to one resolved worktree
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.function_call_arguments.done', name: 'select_worktree', call_id: 'select-ferry', arguments: JSON.stringify({ worktree_id: 'ferry-fyi' }) }) })));
  await expect(page.getByRole('tab', { name: /Ferry FYI/u })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.voice-context')).toContainText('Active: Ferry FYI');
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string; item?: { type?: string; call_id?: string; output?: string } }).find(value => value.type === 'conversation.item.create' && value.item?.call_id === 'select-ferry'))).toMatchObject({ item: { type: 'function_call_output', call_id: 'select-ferry', output: expect.stringContaining('Ferry FYI') } });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string }).filter(value => value.type === 'response.create').length)).toBe(3);
  const assistantMessages = await page.locator('.voice-assistant').count();
  // cancel a bare interruption without replying
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'interrupt-1', transcript: 'Shut up.' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.created', response: { id: 'interrupted-response' } }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.started' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'All right.' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'error', error: { code: 'response_cancel_not_active' } }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.done', response: { id: 'interrupted-response', status: 'cancelled' } }) }));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string }).filter(value => value.type === 'response.cancel').length)).toBeGreaterThanOrEqual(2);
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoChannel: { sent: string[] } }).davoChannel.sent.map(value => JSON.parse(value) as { type: string }).filter(value => value.type === 'output_audio_buffer.clear').length)).toBeGreaterThanOrEqual(2);
  await expect(page.locator('.voice-assistant')).toHaveCount(assistantMessages);
  await expect(page.locator('.voice-dialog').getByRole('alert')).toHaveCount(0);
  await page.addStyleTag({ content: '.voice-transcript { max-height: 8rem; }' });
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    // fill enough history to require scrolling
    for (let index = 1; index <= 20; index += 1) data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', transcript: `Voice message ${index}` }) }));
  });
  await expect(page.getByText('Voice message 20')).toBeVisible();
  await expect.poll(() => page.locator('.voice-transcript').evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThanOrEqual(1);
  // do not infer hangup from a casual goodbye
  await page.evaluate(() => {
    const data = (window as unknown as { davoChannel: EventTarget }).davoChannel;
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'goodbye-1', transcript: 'Goodbye.' }) }));
    data.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'goodbye-response' }) }));
  });
  await expect(page.getByRole('button', { name: 'Hang up' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoHangupPlays?: number }).davoHangupPlays ?? 0)).toBe(0);
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'hangup-1', transcript: 'Davo, hang up please.' }) })));
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'response.output_audio_transcript.done', transcript: 'Cheers, Ansel.' }) })));
  await expect(page.getByText('Cheers, Ansel.')).toBeVisible();
  await expect(page.locator('.voice-assistant > strong')).toHaveText('Davo');
  await expect(page.getByRole('button', { name: 'Hang up' })).toBeVisible();
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'output_audio_buffer.stopped', response_id: 'goodbye-1' }) })));
  const dialogCall = page.locator('.voice-dialog').getByRole('button', { name: 'Call Davo' });
  await expect(dialogCall).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoHangupPlays?: number }).davoHangupPlays ?? 0)).toBe(1);
  await expect(page.locator('.voice-dialog')).toHaveCount(0, { timeout: 2_500 });
  await page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' }).click();
  await expect(page.getByText('Loading Davo tools…')).toBeVisible();
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed' }) })));
  await page.getByRole('button', { name: 'Hang up' }).click();
  await expect(dialogCall).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { davoHangupPlays?: number }).davoHangupPlays ?? 0)).toBe(2);
  await expect(page.locator('.voice-dialog')).toHaveCount(0, { timeout: 2_500 });
  // keep unexpected provider disconnects visible
  await page.locator('.output-server-switcher').getByRole('button', { name: 'Call Davo' }).click();
  await expect(page.getByText('Loading Davo tools…')).toBeVisible();
  await page.evaluate(() => (window as unknown as { davoChannel: EventTarget }).davoChannel.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'mcp_list_tools.completed' }) })));
  await page.evaluate(() => { const data = (window as unknown as { davoChannel: EventTarget }).davoChannel; data.dispatchEvent(new Event('close')); });
  await expect(page.locator('.voice-dialog').getByRole('alert')).toHaveText('Davo disconnected. Call again to reconnect.');
  await page.waitForTimeout(2_100);
  await expect(page.locator('.voice-dialog')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { davoHangupPlays?: number }).davoHangupPlays ?? 0)).toBe(2);
});
