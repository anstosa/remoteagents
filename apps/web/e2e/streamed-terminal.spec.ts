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

// keep first-command output beside a restored shell prompt
test('restores the prompt cursor after blank seed rows and on reseed', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  const seed = `\x1b[H\x1b[2J$ ${'\r\n'.repeat(9)}\x1b[1;3H`;

  // exercise the initial snapshot and a fresh snapshot on reseed
  for (const reseed of [false, true]) {
    // discard the previous shell display on reseed
    if (reseed) await drive(page, 'pushReseed');
    await drive(page, 'pushBytes', seed);
    await drive(page, 'pushBytes', 'echo first\r\nfirst\r\n$ ');
    // read the rendered lines after all stream bytes are consumed
    await expect.poll(() => drive(page, 'screenText')).toBe(`$ echo first\nfirst\n$ ${'\n'.repeat(7)}`);
  }
});

test('masks the terminal with the themed background until the first seed renders', async ({ page }) => {
  await setup(page);
  // Pre-seed: a cover sits over the terminal so the operator never sees an empty grid or
  // xterm's pre-paint flash before content arrives.
  await expect(page.locator('#term .streamed-terminal-cover')).toBeVisible();
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'SEEDED\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('SEEDED');
  // Once the seed has painted, the cover is removed and never masks the live pane.
  await expect(page.locator('#term .streamed-terminal-cover')).toHaveCount(0);
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

test('letterboxes the smaller pane in the terminal background, not xterm black', async ({ page }) => {
  // A pane shorter than the panel leaves a strip below the last row. xterm's own
  // `.xterm-viewport` is a full-height, hardcoded-black overlay, so without an override
  // that strip shows solid black instead of the themed background — the "black bar at
  // the bottom" operators saw. The strip must paint `--base` like the rest of the pane.
  await setup(page, { width: '640px', height: '320px' });
  await drive(page, 'pushSize', 20, 6);
  await drive(page, 'pushBytes', 'TOP-ROW\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('TOP-ROW');
  const strip = await drive<string>(page, 'letterboxStripColor');
  expect(strip).not.toBe('rgb(0, 0, 0)');
  expect(strip).toBe(await drive<string>(page, 'themeBaseColor'));
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

// freeze visual events while keeping nonvisual pane notifications live
test('selection pause defers bytes, sizes, and acknowledgements until replay', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushBytes', '\r\x1b[2KBUFFERED');
  await drive(page, 'pushBytes', '-AFTER');
  await drive(page, 'pushFrame', { type: 'question', question: { prompt: 'Still live' } });
  await expect.poll(() => drive(page, 'questionsSeen')).toContainEqual({ prompt: 'Still live' });
  await page.waitForTimeout(100);
  expect(await drive(page, 'cols')).toBe(40);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('BUFFERED');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('BUFFERED-AFTER');
  expect(await drive(page, 'cols')).toBe(30);
  expect(await drive(page, 'rows')).toBe(8);
  await expect.poll(() => drive(page, 'ackedBytes')).toEqual([...acknowledgements, '\r\x1b[2KBUFFERED-AFTER'.length]);
});

// pause before xterm's asynchronous parser consumes an already received chunk
test('selection pause gates a write already scheduled for parsing', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  // deliver output and start selection within the same browser task
  await page.evaluate(async () => {
    const fixture = await import('/e2e/streamed-terminal-fixture.ts');
    fixture.pushBytes('\r\x1b[2KBUFFERED');
    fixture.setOutputPaused(true);
  });
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('BUFFERED');
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('BUFFERED');
});

// parse bytes at their original grid before applying the following resize
test('selection replay preserves bytes-before-size ordering', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', '\r\x1b[2K\x1b[1;80HX');
  await drive(page, 'pushSize', 80, 10);
  await drive(page, 'pushBytes', '\x1b[2;1HY');
  await drive(page, 'setOutputPaused', false);
  // inspect the complete row so a wider-grid cursor cannot match as a suffix
  await expect.poll(async () => (await drive<string>(page, 'screenText')).split('\n').slice(0, 2)).toEqual([`${' '.repeat(39)}X`, 'Y']);
  expect(await drive(page, 'cols')).toBe(80);
});

// discard obsolete bytes when the server replaces its snapshot during selection
test('a paused reseed supersedes queued output without losing the latest grid', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'DISCARDED-PRE-SEED');
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushReseed');
  await drive(page, 'pushBytes', 'FRESH-SEED');
  await drive(page, 'pushBytes', '-LIVE');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('FRESH-SEED-LIVE');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('DISCARDED');
  expect(await drive(page, 'cols')).toBe(30);
  await expect.poll(() => drive(page, 'ackedBytes')).toEqual([...acknowledgements, 'FRESH-SEED-LIVE'.length]);
});

// an oversized burst must not force selection to end or replay a truncated stream
test('paused output overflow refreshes from a new seed after selection ends', async ({ page }) => {
  await setup(page);
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  const acknowledgements = await drive<number[]>(page, 'ackedBytes');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'x'.repeat(300 * 1024));
  await drive(page, 'pushBytes', 'INCOMPLETE-TAIL');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive(page, 'ackedBytes')).toEqual(acknowledgements);
  expect(await drive(page, 'connectCalls')).toBe(1);
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'connectCalls')).toBe(2);
  await drive(page, 'pushSize', 40, 10);
  // a fresh live snapshot can itself exceed the selection backlog cap
  await drive(page, 'pushBytes', `${' \r'.repeat(150 * 1024)}RECOVERED`);
  await expect.poll(() => drive(page, 'screenText')).toContain('RECOVERED');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('INCOMPLETE-TAIL');
  expect(await drive(page, 'connectCalls')).toBe(2);
});

// reconnects can refresh the pending snapshot without disturbing the frozen display
test('selection remains frozen across a reconnect until the replacement seed is released', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 10 });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'ORIGINAL');
  await expect.poll(() => drive(page, 'screenText')).toContain('ORIGINAL');
  await drive(page, 'setOutputPaused', true);
  await drive(page, 'pushBytes', 'STALE-QUEUED');
  await drive(page, 'pushClose', 1006, 'lost');
  await expect.poll(() => drive(page, 'connectCalls')).toBe(2);
  await drive(page, 'pushSize', 30, 8);
  await drive(page, 'pushBytes', 'RECONNECTED');
  await page.waitForTimeout(100);
  expect(await drive<string>(page, 'screenText')).toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('RECONNECTED');
  await drive(page, 'setOutputPaused', false);
  await expect.poll(() => drive(page, 'screenText')).toContain('RECONNECTED');
  expect(await drive<string>(page, 'screenText')).not.toContain('ORIGINAL');
  expect(await drive<string>(page, 'screenText')).not.toContain('STALE-QUEUED');
  expect(await drive(page, 'cols')).toBe(30);
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

// retain sharp cached output until the replacement seed arrives
test('a socket loss reconnects and re-seeds without keeping a stale line', async ({ page }) => {
  await setup(page, { reconnectDelayMs: 50, width: '100%' });
  await drive(page, 'pushSize', 40, 10);
  await drive(page, 'pushBytes', 'STALE-LINE\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('STALE-LINE');
  const status = page.locator('#term .streamed-terminal-status');
  await expect(status).toBeHidden();
  await drive(page, 'pushClose', 1006, 'lost');
  await expect.poll(() => drive(page, 'connectCalls')).toBeGreaterThan(1);
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Reconnecting… (1006)');
  await expect(status).toHaveCSS('color', 'rgb(249, 226, 175)');
  expect(await drive<string>(page, 'screenText')).toContain('STALE-LINE');
  await expect(page.locator('#term .streamed-terminal-cover')).toHaveCount(0);
  // measure the text itself rather than its full-pane status container
  for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    // inspect centered text and the original cached-output border and hatching
    const appearance = await status.evaluate(element => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const pane = element.parentElement!.getBoundingClientRect();
      const backdrop = getComputedStyle(element, '::before');
      return {
        horizontalOffset: text.x + text.width / 2 - pane.x - pane.width / 2,
        verticalOffset: text.y + text.height / 2 - pane.y - pane.height / 2,
        backdropFilter: backdrop.backdropFilter,
        filter: backdrop.filter,
        background: backdrop.backgroundColor,
        hatching: backdrop.backgroundImage,
        borderWidth: backdrop.borderTopWidth,
        borderStyle: backdrop.borderTopStyle,
        borderColor: backdrop.borderTopColor
      };
    });
    expect(appearance.horizontalOffset).toBeCloseTo(0, 0);
    expect(appearance.verticalOffset).toBeCloseTo(0, 0);
    expect(appearance.backdropFilter).toBe('none');
    expect(appearance.filter).toBe('none');
    expect(appearance.background).toBe('rgba(0, 0, 0, 0)');
    expect(appearance.hatching).toContain('repeating-linear-gradient(135deg,');
    expect(appearance.borderWidth).toBe('2px');
    expect(appearance.borderStyle).toBe('solid');
    // tolerate color-mix rounding while checking the yellow palette and opacity
    expect(appearance.borderColor).toMatch(/color\(srgb 0\.97647\d* 0\.88627\d* 0\.68627\d* \/ 0\.58\)/u);
  }
  await drive(page, 'pushSize', 40, 10);
  await expect(status).toBeVisible();
  await drive(page, 'pushBytes', 'AFTER-RECONNECT\r\n');
  await expect.poll(() => drive(page, 'screenText')).toContain('AFTER-RECONNECT');
  expect(await drive<string>(page, 'screenText')).not.toContain('STALE-LINE');
  await expect(status).toBeHidden();
});

// keep the jump control centered and clickable across viewport sizes
test('the jump-to-latest control stays bottom-centered and returns to following', async ({ page }) => {
  await setup(page, { scrollback: 500, width: '100%' });
  await drive(page, 'pushSize', 40, 10);
  let payload = '';
  // fill enough scrollback to reveal the jump control
  for (let line = 1; line <= 60; line += 1) payload += `row-${line}\r\n`;
  await drive(page, 'pushBytes', payload);
  // wait for scrollback before scrolling
  await expect.poll(() => drive(page, 'baseY')).toBeGreaterThan(0);
  expect(await drive(page, 'jumpHidden')).toBe(true);

  // check desktop and phone placement with real pointer clicks
  for (const viewport of [{ width: 1400, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await drive(page, 'scrollUp', 20);
    const jump = page.getByRole('button', { name: 'Jump to latest' });
    await expect(jump).toBeVisible();
    const panelBox = await page.locator('#term').boundingBox();
    const jumpBox = await jump.boundingBox();
    expect(panelBox).not.toBeNull();
    expect(jumpBox).not.toBeNull();
    expect(jumpBox!.x + jumpBox!.width / 2).toBeCloseTo(panelBox!.x + panelBox!.width / 2, 0);
    expect(panelBox!.y + panelBox!.height - jumpBox!.y - jumpBox!.height).toBeCloseTo(12, 0);
    await jump.click();
    const base = await drive<number>(page, 'baseY');
    // wait for the viewport to follow the latest output
    await expect.poll(() => drive(page, 'viewportY')).toBe(base);
    await expect(jump).toBeHidden();
  }
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
    // A scroll drag never becomes a click, so it must not focus the terminal — a scroll
    // must not summon the soft keyboard.
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);

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
    // A touch that never becomes a click (a scroll, or a browser-suppressed tap) must not
    // focus: iOS only raises the keyboard for a focus made from the synthesized click, so
    // focusing on touchend would leave the textarea focused without a keyboard.
    await drive(page, 'touchOnly');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(false);
    // The synthesized click a genuine tap produces focuses the hidden textarea, mirroring
    // the retired snapshot Log's coarse-pointer affordance that raised the soft keyboard.
    await drive(page, 'tap');
    expect(await drive(page, 'activeIsTerminalTextarea')).toBe(true);
    // With the tap-summoned keyboard focused, typed characters reach the pane socket.
    await page.keyboard.type('hi');
    await expect.poll(() => drive(page, 'inputData')).toBe('hi');
  } finally {
    await context.close();
  }
});
