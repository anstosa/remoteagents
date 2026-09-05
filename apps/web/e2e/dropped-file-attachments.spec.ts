import { expect, test, type Locator, type Page, type Route } from '@playwright/test';

type DroppedFile = {
  name: string;
  mimeType?: string;
  body?: string;
  size?: number;
  directory?: boolean;
};

type PromptRequestHandler = (route: Route) => Promise<void> | void;

// serve one active composer with optional prompt control
const mockComposerApi = async (page: Page, promptRequest?: PromptRequestHandler) => {
  // isolate the composer from backend state
  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    // authenticate the local console
    if (url.pathname === '/api/auth/session') return route.fulfill({ json: { csrfToken: 'csrf-token', active: true, deviceName: 'Test device' } });
    // expose one idle agent
    if (url.pathname === '/api/dashboard') return route.fulfill({ json: { generation: 1, agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Ready', kind: 'codex', attention: 'finished' }], projects: [] } });
    // disable push enrollment
    if (url.pathname === '/api/push/public-key') return route.fulfill({ json: {} });
    // provide websocket tickets
    if (url.pathname === '/api/agents/agent-1/tickets') return route.fulfill({ json: { ticket: 'test-ticket' } });
    // return no saved prompts
    if (url.pathname === '/api/agents/agent-1/saved-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // return no queued prompts
    if (url.pathname === '/api/agents/agent-1/queued-prompts' && request.method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    // let tests inspect prompt submission
    if (url.pathname === '/api/agents/agent-1/prompt' && request.method() === 'POST' && promptRequest !== undefined) return promptRequest(route);
    // allow terminal transitions
    if (url.pathname === '/api/agents/agent-1/background' || url.pathname === '/api/agents/agent-1/foreground') return route.fulfill({ status: 204 });
    return route.fulfill({ status: 404, json: { error: 'not mocked' } });
  });
};

// dispatch a synthetic file drag from the browser
const dispatchFileDrag = async (target: Locator, type: 'dragenter' | 'dragover' | 'dragleave' | 'dragend' | 'drop', files: DroppedFile[]) => target.evaluate((element, payload) => {
  const transfer = new DataTransfer();
  const directoryNames = new Set<string>();
  // populate the protected file transfer
  for (const candidate of payload.files) {
    const contents = candidate.size === undefined ? candidate.body ?? '' : new Uint8Array(candidate.size);
    const file = new File([contents], candidate.name, { type: candidate.mimeType ?? 'application/octet-stream' });
    transfer.items.add(file);
    // remember synthetic directory entries
    if (candidate.directory) directoryNames.add(candidate.name);
  }
  const itemPrototype = DataTransferItem.prototype;
  const originalEntryDescriptor = Object.getOwnPropertyDescriptor(itemPrototype, 'webkitGetAsEntry');
  const originalEntry = itemPrototype.webkitGetAsEntry;
  // mark directory wrappers returned during dispatch
  if (directoryNames.size > 0) Object.defineProperty(itemPrototype, 'webkitGetAsEntry', {
    configurable: true,
    // report only marked files as directories
    value: function (this: DataTransferItem) {
      const file = this.getAsFile();
      // expose the synthetic directory marker
      if (file !== null && directoryNames.has(file.name)) return { isDirectory: true };
      return originalEntry.call(this);
    }
  });
  try {
    const event = new DragEvent(payload.type, { bubbles: true, cancelable: true, dataTransfer: transfer });
    return { defaultAllowed: element.dispatchEvent(event), dropEffect: transfer.dropEffect };
  } finally {
    // restore the native directory lookup
    if (directoryNames.size > 0) {
      // restore the original descriptor when present
      if (originalEntryDescriptor !== undefined) Object.defineProperty(itemPrototype, 'webkitGetAsEntry', originalEntryDescriptor);
      // remove the temporary method otherwise
      else Reflect.deleteProperty(itemPrototype, 'webkitGetAsEntry');
    }
  }
}, { type, files });

// dispatch a browser-owned text or link drag
const dispatchTextDrag = async (target: Locator, type: 'dragenter' | 'dragover' | 'drop') => target.evaluate((element, eventType) => {
  const transfer = new DataTransfer();
  transfer.setData('text/plain', 'Dragged prompt text');
  transfer.setData('text/uri-list', 'https://example.com/context');
  return element.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer: transfer }));
}, type);

// locate the normal prompt section
const promptComposer = (page: Page) => page.getByRole('region', { name: 'Prompt composer' });

// verify append, removal, and submission behavior
test('appends dropped files, removes a chip, and queues the unchanged draft with base64 attachments', async ({ page }) => {
  let queued: unknown;
  // capture the accepted queue payload
  await mockComposerApi(page, route => {
    queued = route.request().postDataJSON();
    return route.fulfill({ status: 202, json: { queued: true } });
  });

  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep this draft exactly.');

  const firstDrop = await dispatchFileDrag(prompt, 'drop', [{ name: 'existing.txt', mimeType: 'text/plain', body: 'existing context' }]);
  expect(firstDrop.defaultAllowed).toBe(false);
  const appendedDrop = await dispatchFileDrag(composer.getByRole('button', { name: 'More options' }), 'drop', [
    { name: 'requirements.md', mimeType: 'text/markdown', body: '# requirements' },
    { name: 'remove-me.json', mimeType: 'application/json', body: '{"remove":true}' }
  ]);
  expect(appendedDrop.defaultAllowed).toBe(false);

  const attachments = page.getByLabel('Selected attachments');
  await expect(prompt).toHaveValue('Keep this draft exactly.');
  await expect(attachments.getByRole('button')).toHaveCount(3);
  await expect(attachments).toContainText('existing.txt');
  await expect(attachments).toContainText('requirements.md');
  await expect(attachments).toContainText('remove-me.json');
  expect(queued).toBeUndefined();

  await page.getByRole('button', { name: 'Remove remove-me.json' }).click();
  await expect(attachments.getByRole('button')).toHaveCount(2);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();

  await expect.poll(() => queued).toEqual({
    prompt: 'Keep this draft exactly.',
    attachments: [
      { name: 'existing.txt', data: Buffer.from('existing context').toString('base64') },
      { name: 'requirements.md', data: Buffer.from('# requirements').toString('base64') }
    ]
  });
  await expect(attachments).toHaveCount(0);
});

// verify the attachment-count boundary
test('accepts ten files and rejects the entire eleventh-file addition without losing the draft', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Preserve count-boundary state.');
  // build the exact file-count boundary
  const accepted = Array.from({ length: 10 }, (_, index) => ({ name: `accepted-${index + 1}.txt`, body: `${index + 1}` }));

  await dispatchFileDrag(composer, 'drop', accepted);
  await expect(page.getByLabel('Selected attachments').getByRole('button')).toHaveCount(10);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await dispatchFileDrag(composer, 'drop', [{ name: 'eleventh.txt', body: 'reject this entire addition' }]);
  await expect(page.getByRole('alert')).toHaveText('Attach up to 10 files.');
  await expect(page.getByLabel('Selected attachments').getByRole('button')).toHaveCount(10);
  await expect(page.getByLabel('Selected attachments')).not.toContainText('eleventh.txt');
  await expect(prompt).toHaveValue('Preserve count-boundary state.');
});

// verify the attachment-size boundary
test('accepts exactly 25 MiB and rejects a larger total without replacing the accepted file', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Preserve size-boundary state.');

  await dispatchFileDrag(composer, 'drop', [{ name: 'exact-limit.bin', size: 25 * 1024 * 1024 }]);
  const attachments = page.getByLabel('Selected attachments');
  await expect(attachments.getByRole('button')).toHaveCount(1);
  await expect(page.getByRole('alert')).toHaveCount(0);

  await dispatchFileDrag(composer, 'drop', [
    { name: 'overflow-a.txt', body: 'a' },
    { name: 'overflow-b.txt', body: 'b' }
  ]);
  await expect(page.getByRole('alert')).toHaveText('Attachments must total 25 MB or less.');
  await expect(attachments.getByRole('button')).toHaveCount(1);
  await expect(attachments).toContainText('exact-limit.bin');
  await expect(attachments).not.toContainText('overflow-a.txt');
  await expect(attachments).not.toContainText('overflow-b.txt');
  await expect(prompt).toHaveValue('Preserve size-boundary state.');
});

// verify browser-owned drag behavior
test('leaves text and link drags unhandled', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Keep browser-owned drag behavior.');

  expect(await dispatchTextDrag(prompt, 'dragenter')).toBe(true);
  expect(await dispatchTextDrag(composer.getByRole('button', { name: 'More options' }), 'dragover')).toBe(true);
  expect(await dispatchTextDrag(composer, 'drop')).toBe(true);
  await expect(page.getByRole('status').filter({ hasText: 'Drop files to attach' })).toHaveCount(0);
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
  await expect(prompt).toHaveValue('Keep browser-owned drag behavior.');
});

// verify nested hover stability
test('keeps the file-drop overlay stable while crossing nested composer targets and clears it on leave', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  const actions = composer.getByRole('button', { name: 'More options' });
  const overlay = page.getByRole('status').filter({ hasText: 'Drop files to attach' });
  const before = await composer.boundingBox();
  expect(before).not.toBeNull();

  await dispatchFileDrag(prompt, 'dragenter', [{ name: 'hover.txt', body: 'hover' }]);
  await expect(overlay).toBeVisible();
  const during = await composer.boundingBox();
  expect(during).toEqual(before);

  await dispatchFileDrag(actions, 'dragenter', [{ name: 'hover.txt', body: 'hover' }]);
  await dispatchFileDrag(prompt, 'dragleave', [{ name: 'hover.txt', body: 'hover' }]);
  await expect(overlay).toBeVisible();
  await dispatchFileDrag(actions, 'dragleave', [{ name: 'hover.txt', body: 'hover' }]);
  await expect(overlay).toHaveCount(0);
  const after = await composer.boundingBox();
  expect(after).toEqual(before);
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// verify visible folder rejection
test('rejects folders visibly without losing earlier files', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  const composer = promptComposer(page);

  await dispatchFileDrag(composer, 'drop', [{ name: 'keep.txt', body: 'keep this file' }]);
  const directoryDrop = await dispatchFileDrag(composer, 'drop', [{ name: 'screenshots', directory: true }]);
  expect(directoryDrop.defaultAllowed).toBe(false);
  await expect(page.getByRole('alert')).toHaveText('Folders cannot be attached. Drop individual files instead.');
  await expect(page.getByLabel('Selected attachments').getByRole('button')).toHaveCount(1);
  await expect(page.getByLabel('Selected attachments')).toContainText('keep.txt');
  await expect(page.getByLabel('Selected attachments')).not.toContainText('screenshots');
});

// verify the pending-submission guard
test('prevents navigation but does not accept files while prompt submission is pending', async ({ page }) => {
  let finishQueue!: () => void;
  let queued: unknown;
  // expose the request release gate
  const queueFinished = new Promise<void>(resolve => { finishQueue = resolve; });
  // hold submission through guard assertions
  await mockComposerApi(page, async route => {
    queued = route.request().postDataJSON();
    await queueFinished;
    return route.fulfill({ status: 202, json: { queued: true } });
  });

  await page.goto('/');
  const composer = promptComposer(page);
  const prompt = page.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('Submit before dropping.');
  await dispatchFileDrag(composer, 'drop', [{ name: 'submitted.txt', body: 'submitted context' }]);
  await page.getByRole('button', { name: 'Queue', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Queueing' })).toBeDisabled();
  await expect.poll(() => queued).toEqual({
    prompt: 'Submit before dropping.',
    attachments: [{ name: 'submitted.txt', data: Buffer.from('submitted context').toString('base64') }]
  });

  const hover = await dispatchFileDrag(composer, 'dragenter', [{ name: 'blocked.txt', body: 'blocked' }]);
  const dropped = await dispatchFileDrag(composer, 'drop', [{ name: 'blocked.txt', body: 'blocked' }]);
  expect(hover.defaultAllowed).toBe(false);
  expect(dropped.defaultAllowed).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: 'Drop files to attach' })).toHaveCount(0);
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);

  finishQueue();
  await expect(page.getByRole('button', { name: 'Queue', exact: true })).toBeDisabled();
});

// keep pending saves from silently clearing newly dropped files
test('rejects drops while a saved prompt is being written', async ({ page }) => {
  await mockComposerApi(page);
  let savedRequest: unknown;
  let finishSave!: () => void;
  // hold the saved snapshot until the drop has been attempted
  const saved = new Promise<void>(resolve => { finishSave = resolve; });
  // model the saved-prompt persistence boundary
  await page.route('**/api/agents/agent-1/saved-prompts', async route => {
    // keep the initial saved list empty
    if (route.request().method() === 'GET') return route.fulfill({ json: { prompts: [] } });
    savedRequest = route.request().postDataJSON();
    await saved;
    return route.fulfill({ json: { id: 'saved-original', text: 'Save this draft', attachments: [{ name: 'original.txt', size: 8 }] } });
  });
  await page.goto('/');
  const composer = promptComposer(page);
  await page.getByRole('textbox', { name: 'Prompt' }).fill('Save this draft');
  await dispatchFileDrag(composer, 'drop', [{ name: 'original.txt', body: 'original' }]);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Saving', exact: true })).toBeDisabled();
  await expect.poll(() => savedRequest).toEqual({ prompt: 'Save this draft', attachments: [{ name: 'original.txt', data: Buffer.from('original').toString('base64') }] });
  try {
    await dispatchFileDrag(composer, 'dragenter', [{ name: 'late.txt', body: 'late' }]);
    const dropped = await dispatchFileDrag(composer, 'drop', [{ name: 'late.txt', body: 'late' }]);
    expect(dropped.defaultAllowed).toBe(false);
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late.txt');
    // reject pasted images while the same attachment snapshot is owned
    await page.getByRole('textbox', { name: 'Prompt' }).evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['late image'], 'late-paste.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late-paste.png');
    // reject a file-picker change that arrives after the operation started
    await composer.locator('input[type="file"]').setInputFiles({ name: 'late-picker.txt', mimeType: 'text/plain', buffer: Buffer.from('late picker') });
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late-picker.txt');
    await expect(page.getByRole('status').filter({ hasText: 'Drop files to attach' })).toHaveCount(0);
  } finally {
    // release the request even when a regression fails an assertion
    finishSave();
  }
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
  await dispatchFileDrag(composer, 'drop', [{ name: 'after-save.txt', body: 'new draft' }]);
  await expect(page.getByLabel('Selected attachments')).toContainText('after-save.txt');
});

// keep restore preflight limits valid until its files have been appended
test('rejects drops while a saved prompt is being restored', async ({ page }) => {
  await mockComposerApi(page);
  let restoring = false;
  let finishRestore!: () => void;
  // pause the restore response after its limit check
  const restored = new Promise<void>(resolve => { finishRestore = resolve; });
  // expose one attachment-bearing saved draft
  await page.route('**/api/agents/agent-1/saved-prompts', route => route.fulfill({ json: { prompts: [{ id: 'saved-restore', text: 'Restore this draft', attachments: [{ name: 'restored.txt', size: 8 }] }] } }));
  // hold the consumed saved draft at the persistence boundary
  await page.route('**/api/agents/agent-1/saved-prompts/saved-restore', async route => {
    restoring = true;
    await restored;
    return route.fulfill({ json: { id: 'saved-restore', text: 'Restore this draft', attachments: [{ name: 'restored.txt', data: Buffer.from('restored').toString('base64') }] } });
  });
  await page.goto('/');
  const composer = promptComposer(page);
  // leave exactly one slot for the saved attachment
  const existing = Array.from({ length: 9 }, (_, index) => ({ name: `existing-${index}.txt`, body: 'existing' }));
  await dispatchFileDrag(composer, 'drop', existing);
  await page.getByRole('button', { name: 'Saved prompts (1)' }).click();
  await page.getByRole('button', { name: /^Restore this draft/u }).click();
  await expect.poll(() => restoring).toBe(true);
  // dismiss the flyout while its restore request is still pending
  await page.mouse.click(1, 1);
  try {
    const dropped = await dispatchFileDrag(composer, 'drop', [{ name: 'late.txt', body: 'late' }]);
    expect(dropped.defaultAllowed).toBe(false);
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late.txt');
    // reject pasted images while the same attachment snapshot is owned
    await page.getByRole('textbox', { name: 'Prompt' }).evaluate(element => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['late image'], 'late-paste.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
    });
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late-paste.png');
    // reject a file-picker change that arrives after the operation started
    await composer.locator('input[type="file"]').setInputFiles({ name: 'late-picker.txt', mimeType: 'text/plain', buffer: Buffer.from('late picker') });
    await expect(page.getByLabel('Selected attachments')).not.toContainText('late-picker.txt');
  } finally {
    // allow the original restore to complete
    finishRestore();
  }
  await expect(page.getByLabel('Selected attachments').getByRole('button')).toHaveCount(10);
  await expect(page.getByLabel('Selected attachments')).toContainText('restored.txt');
  await page.getByRole('button', { name: 'Remove restored.txt' }).click();
  await dispatchFileDrag(composer, 'drop', [{ name: 'after-restore.txt', body: 'new context' }]);
  await expect(page.getByLabel('Selected attachments')).toContainText('after-restore.txt');
});

// keep file drops from navigating away while an inline answer is required
test('prevents file-drop navigation in question mode', async ({ page }) => {
  await mockComposerApi(page);
  // publish the current question through the normal dashboard contract
  await page.route('**/api/dashboard', route => route.fulfill({ json: { generation: 1, projects: [], agents: [{ id: 'agent-1', sessionId: 'socket:$1', workspace: '/worktrees/cora', title: 'Question', kind: 'codex', attention: 'question', question: { id: 'drop-question', text: 'Which environment?', choices: ['Staging', 'Production'], source: 'parsed' } }] } }));
  await page.goto('/');
  const question = page.getByRole('button', { name: 'Staging', exact: true });
  await expect(question).toBeVisible();
  const dropped = await dispatchFileDrag(question, 'drop', [{ name: 'blocked.txt', body: 'blocked' }]);
  expect(dropped.defaultAllowed).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: 'Drop files to attach' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch to normal prompt mode' }).click();
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
});

// verify the swapped-terminal guard
test('prevents navigation but does not accept files in swapped terminal mode', async ({ page }) => {
  await mockComposerApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'More options' }).click();
  await page.getByRole('button', { name: 'Swap to terminal' }).click();
  await expect(page.getByLabel('Interactive agent pane')).toBeVisible();

  const composer = promptComposer(page);
  const hover = await dispatchFileDrag(composer.getByRole('button', { name: 'More options' }), 'dragover', [{ name: 'blocked.txt', body: 'blocked' }]);
  const dropped = await dispatchFileDrag(page.getByRole('textbox', { name: 'Prompt' }), 'drop', [{ name: 'blocked.txt', body: 'blocked' }]);
  expect(hover.defaultAllowed).toBe(false);
  expect(dropped.defaultAllowed).toBe(false);
  await expect(page.getByRole('status').filter({ hasText: 'Drop files to attach' })).toHaveCount(0);
  await expect(page.getByLabel('Selected attachments')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enter', exact: true })).toBeVisible();
});
