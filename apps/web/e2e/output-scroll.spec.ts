import { expect, test } from '@playwright/test';

test('contains wheel and touch scroll events inside output mode', async ({ page }) => {
  await page.goto('/');
  await page.setContent('<div id="outside"><div id="output"><div id="terminal"></div></div></div>');

  const result = await page.evaluate(async () => {
    const { containOutputScroll } = await import('/src/output-scroll.ts');
    const outside = document.querySelector<HTMLElement>('#outside')!;
    const output = document.querySelector<HTMLElement>('#output')!;
    const terminal = document.querySelector<HTMLElement>('#terminal')!;
    let terminalEvents = 0;
    let outsideEvents = 0;
    const countTerminal = () => { terminalEvents += 1; };
    const countOutside = () => { outsideEvents += 1; };

    terminal.addEventListener('wheel', countTerminal);
    terminal.addEventListener('touchmove', countTerminal);
    outside.addEventListener('wheel', countOutside);
    outside.addEventListener('touchmove', countOutside);

    const release = containOutputScroll(output);
    const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 });
    const touch = new Event('touchmove', { bubbles: true, cancelable: true });
    const wheelDispatched = terminal.dispatchEvent(wheel);
    const touchDispatched = terminal.dispatchEvent(touch);
    const contained = { terminalEvents, outsideEvents, wheelDispatched, touchDispatched, wheelPrevented: wheel.defaultPrevented, touchPrevented: touch.defaultPrevented };

    release();
    terminal.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
    return { contained, released: { terminalEvents, outsideEvents } };
  });

  expect(result.contained).toEqual({
    terminalEvents: 0,
    outsideEvents: 0,
    wheelDispatched: false,
    touchDispatched: false,
    wheelPrevented: true,
    touchPrevented: true
  });
  expect(result.released).toEqual({ terminalEvents: 1, outsideEvents: 1 });
});
