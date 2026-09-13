import { expect, test, type Page } from '@playwright/test';

// The streamed terminal component, mounted alone against real xterm 6.0 and driven by
// a scripted socket (see streamed-terminal-fixture.ts). These assert what crosses the
// contract boundary — rendered DOM, the frames the component sends — never its
// internals.

const MOBILE = {
  hasTouch: true,
  isMobile: true,
  userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36',
  viewport: { width: 390, height: 780 }
} as const;

// Call an exported fixture function in the page and return its (serializable) result.
const drive = <T = unknown>(page: Page, name: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(async ({ name, args }) => {
    const module = await import('/e2e/streamed-terminal-fixture.ts');
    return (module as Record<string, (...a: unknown[]) => unknown>)[name]!(...args) as T;
  }, { name, args });

const setup = async (page: Page, options: Record<string, unknown> = {}) => {
  await page.goto('/');
  // Clear the app's DOM but keep the <head> the app injected: the Catppuccin palette
  // <style> lives there, and the component reads its theme from those `:root` tokens
  // exactly as it does in the app. page.setContent() would replace the whole document
  // and drop that <style> — Vite dedupes the already-loaded CSS module, so re-importing
  // styles.css in the fixture would not re-inject it — leaving `--base` unresolved and
  // the terminal theme stuck on xterm's black default.
  await page.evaluate(async options => {
    document.body.replaceChildren();
    const mount = document.createElement('div');
    mount.id = 'term';
    document.body.append(mount);
    const module = await import('/e2e/streamed-terminal-fixture.ts');
    await module.renderStreamedTerminal(mount, options);
  }, options);
  await expect(page.locator('#term')).toHaveAttribute('data-ready', 'true');
};

test('applies the seed then live bytes in order after the first size', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'SEED-LINE\r\n');
  await drive(page, 'pushBytes', 'LIVE-LINE\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('SEED-LINE');
  const text = await drive<string>(page, 'screenText');
  expect(text.indexOf('SEED-LINE')).toBeLessThan(text.indexOf('LIVE-LINE'));
});

test('conforms to the reported size and letterboxes a smaller pane', async ({ page }) => {
  await setup(page, { width: '640px', height: '320px' });
  await drive(page, 'pushSize', 20, 6);
  await expect.poll(() => drive(page, 'cols')).toBe(20);
  expect(await drive(page, 'rows')).toBe(6);
  const screenWidth = await drive<number>(page, 'screenWidth');
  const hostWidth = await drive<number>(page, 'hostWidth');
  expect(screenWidth).toBeGreaterThan(0);
  // Rendered at its natural grid, not stretched to fill the container.
  expect(screenWidth).toBeLessThan(hostWidth);
});

test('a reseed clears the scrollback and re-renders from the fresh seed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'OLD-CONTENT\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('OLD-CONTENT');
  await drive(page, 'pushReseed');
  await drive(page, 'pushBytes', 'FRESH-SEED\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('FRESH-SEED');
  expect(await drive<string>(page, 'screenText')).not.toContain('OLD-CONTENT');
});

test('acks the bytes it consumes', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'hello'); // five bytes
  await expect.poll(() => drive(page, 'ackedBytes')).toContain(5);
});

test('typed keys are sent as input frames through the panel modifier transform', async ({ page }) => {
  await setup(page, { upperCaseInput: true });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'focusTerminal');
  await page.keyboard.type('hi');
  await expect.poll(() => drive(page, 'inputData')).toBe('HI');
});

test('an exit keeps the terminal mounted and shows a status', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 60_000 });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'before-exit\r\n');
  await drive(page, 'pushExit', 'pane closed');
  await expect(page.locator('#term')).toHaveAttribute('data-status', 'pane closed');
  expect(await drive(page, 'terminalMounted')).toBe(true);
});

test('never types a reply back into the pane for device queries', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  const beforeAcks = (await drive<number[]>(page, 'ackedBytes')).length;
  const queries = [
    '\x1b[c', '\x1b[>c', '\x1b[5n', '\x1b[6n', '\x1b[?6n',
    '\x1b[4$p', '\x1b[?2026$p', '\x1bP$qm\x1b\\',
    '\x1b]4;1;?\x07', '\x1b]10;?\x07', '\x1b]11;?\x07', '\x1b]12;?\x07'
  ];
  for (const query of queries) await drive(page, 'pushBytes', query);
  await page.waitForTimeout(150);
  // The bytes were consumed (acked) — so "no input frame" is a real result, not vacuous.
  expect((await drive<number[]>(page, 'ackedBytes')).length).toBeGreaterThan(beforeAcks);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
});

test('device-query suppression survives the reset on a reseed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'seed\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('seed');
  await drive(page, 'pushReseed');
  const before = await drive<number>(page, 'inputFrameCount');
  // The fresh seed clears the screen (reset) then begins with device queries; the
  // registered safety handlers must survive the reset and still suppress them.
  await drive(page, 'pushBytes', '\x1b[6n\x1b[c\x1b[5n');
  await page.waitForTimeout(150);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
});

test('OSC 52 cannot type into the pane and does not read the clipboard', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __clipReads: number }).__clipReads = 0;
    try {
      const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
      if (read) navigator.clipboard.readText = () => { (window as unknown as { __clipReads: number }).__clipReads += 1; return read(); };
    } catch { /* no clipboard API in this context */ }
  });
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  const beforeAcks = (await drive<number[]>(page, 'ackedBytes')).length;
  await drive(page, 'pushBytes', '\x1b]52;c;?\x07');
  await drive(page, 'pushBytes', '\x1b]52;c;aGVsbG8=\x07');
  await page.waitForTimeout(150);
  expect((await drive<number[]>(page, 'ackedBytes')).length).toBeGreaterThan(beforeAcks);
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before);
  expect(await page.evaluate(() => (window as unknown as { __clipReads: number }).__clipReads)).toBe(0);
});

test('OSC 10/11/12 sets leave the terminal theme alone', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  // Positive control: the observable is the live theme background, not a static value —
  // so a set that slipped through would actually change it.
  const before = await drive<string>(page, 'scrollableBackground');
  expect(before).not.toBe('');
  expect(before).not.toBe('rgb(0, 0, 0)');
  await drive(page, 'pushBytes', '\x1b]11;rgb:ffff/0000/0000\x07'); // background red, if it were applied
  await drive(page, 'pushBytes', '\x1b]10;rgb:0000/ffff/0000\x07'); // foreground green
  await drive(page, 'pushBytes', '\x1b]12;rgb:0000/0000/ffff\x07'); // cursor blue
  await page.waitForTimeout(150);
  expect(await drive<string>(page, 'scrollableBackground')).toBe(before);
});

test('a huge REP or SU completes without hanging the page', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', '\x1b[2147483647b'); // REP
  await drive(page, 'pushBytes', '\x1b[1000000S'); // SU
  await drive(page, 'pushBytes', 'STILL-ALIVE\r\n');
  await expect.poll(() => drive(page, 'screenText'), { timeout: 5000 }).toContain('STILL-ALIVE');
});

test('font size and colour theme changes apply live', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'setFont', 20);
  await expect.poll(() => drive(page, 'fontSizePx')).toBe(20);
  const beforeBackground = await drive<string>(page, 'themeBackground');
  await drive(page, 'setTheme', 'latte');
  await expect.poll(() => drive(page, 'themeBackground')).not.toBe(beforeBackground);
  await drive(page, 'setTheme', 'mocha'); // restore shared browser storage
});

test('writes nothing until the first size, then flushes buffered bytes in order', async ({ page }) => {
  await setup(page);
  // No size yet: bytes must be buffered, not rendered.
  await drive(page, 'pushBytes', 'EARLY-A\r\n');
  await drive(page, 'pushBytes', 'EARLY-B\r\n');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).not.toContain('EARLY-A');
  await drive(page, 'pushSize', 40, 10);
  await expect.poll(() => drive(page, 'screenText')).toContain('EARLY-A');
  const text = await drive<string>(page, 'screenText');
  expect(text.indexOf('EARLY-A')).toBeLessThan(text.indexOf('EARLY-B'));
});

test('a socket loss reconnects and re-seeds without keeping a stale line', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 50 });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'STALE-LINE\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('STALE-LINE');
  await drive(page, 'pushClose', 1006, 'lost');
  await expect.poll(() => drive(page, 'connectCalls')).toBeGreaterThan(1);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'AFTER-RECONNECT\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('AFTER-RECONNECT');
  expect(await drive<string>(page, 'screenText')).not.toContain('STALE-LINE');
});

test('the jump-to-latest control appears when scrolled up and returns to following', async ({ page }) => {
  await setup(page, { scrollback: 500 });
  await drive(page, 'pushSize', 40, 10);
  let payload = '';
  for (let line = 1; line <= 60; line += 1) payload += `row-${line}\r\n`;
  await drive(page, 'pushBytes', payload);
  await expect.poll(() => drive(page, 'baseY')).toBeGreaterThan(0);
  expect(await drive(page, 'jumpHidden')).toBe(true); // pinned to the bottom
  await drive(page, 'scrollUp', 20);
  await expect.poll(() => drive(page, 'jumpHidden')).toBe(false); // scrolled into history
  await drive(page, 'clickJump');
  const base = await drive<number>(page, 'baseY');
  await expect.poll(() => drive(page, 'viewportY')).toBe(base);
  expect(await drive(page, 'jumpHidden')).toBe(true);
});

test('server question and metadata frames reach their callbacks, and metadata can be requested', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushFrame', { type: 'question', question: { prompt: 'Pick one' } });
  await expect.poll(() => drive(page, 'questionsSeen')).toContainEqual({ prompt: 'Pick one' });
  await drive(page, 'requestMetadata');
  expect(await drive<string[]>(page, 'sentFrames')).toContain('metadata');
});

test('a large paste is split into multiple input frames within the byte cap', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const before = await drive<number>(page, 'inputFrameCount');
  await drive(page, 'sendInputRaw', 'x'.repeat(100 * 1024)); // 100 KiB, over the 64 KiB cap
  expect(await drive<number>(page, 'inputFrameCount')).toBe(before + 2);
});

test('a touch drag scrolls the browser scrollback and defers in the alternate screen', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { width: '340px', height: '420px', scrollback: 500 });
    await drive(page, 'pushSize', 40, 12);
    let payload = '';
    for (let line = 1; line <= 60; line += 1) payload += `line-${String(line).padStart(2, '0')}\r\n`;
    await drive(page, 'pushBytes', payload);
    await expect.poll(() => drive(page, 'baseY')).toBeGreaterThan(0);
    const base = await drive<number>(page, 'baseY');
    expect(await drive<number>(page, 'viewportY')).toBe(base); // pinned to the bottom
    const owned = await drive<boolean>(page, 'touchDrag', 120); // finger down → history
    expect(owned).toBe(true);
    expect(await drive<number>(page, 'viewportY')).toBeLessThan(base);

    await drive(page, 'pushBytes', '\x1b[?1049h'); // enter the alternate screen
    await expect.poll(() => drive(page, 'alternateScreen')).toBe(true);
    const beforeAlt = await drive<number>(page, 'viewportY');
    const ownedInAlt = await drive<boolean>(page, 'touchDrag', 120);
    expect(ownedInAlt).toBe(false); // left to the program
    expect(await drive<number>(page, 'viewportY')).toBe(beforeAlt);
  } finally {
    await context.close();
  }
});

test('a tap focuses the terminal textarea so the soft keyboard opens', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL: baseURL ?? undefined, ...MOBILE });
  const page = await context.newPage();
  try {
    await setup(page, { width: '340px', height: '420px' });
    await drive(page, 'pushSize', 40, 12);
    await drive(page, 'pushBytes', 'tap here\r\n');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    await drive(page, 'tap');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(true);
  } finally {
    await context.close();
  }
});
