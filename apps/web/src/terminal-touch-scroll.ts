import type { Terminal as XTerm } from '@xterm/xterm';

// xterm.js 6.0 has no touch history scrolling of its own, so the console owns it: a
// one-finger drag over a pane with scrollback moves the browser's scrollback. The
// listeners are capture-phase and non-passive so they run before xterm and can
// swallow the gesture. In the alternate screen (which has no scrollback) or while the
// program is tracking the mouse, the drag is left for xterm to forward to the
// program, exactly as a real terminal behaves. The wheel stays native (xterm handles
// it with `scrollOnUserInput` off).

const FALLBACK_CELL_HEIGHT = 17;

export const attachTerminalTouchScroll = (element: HTMLElement, terminal: XTerm): (() => void) => {
  let gesture: { id: number; lastY: number; remainder: number } | undefined;

  // Leave the gesture to the program when there is nothing local to scroll.
  const deferToProgram = () =>
    terminal.buffer.active.type === 'alternate' || terminal.modes.mouseTrackingMode !== 'none';

  const cellHeight = () => {
    const screen = element.querySelector<HTMLElement>('.xterm-screen');
    const measured = screen && terminal.rows > 0 ? screen.clientHeight / terminal.rows : 0;
    return measured > 0 ? measured : FALLBACK_CELL_HEIGHT;
  };

  const start = (event: TouchEvent) => {
    if (event.touches.length !== 1 || deferToProgram()) { gesture = undefined; return; }
    const touch = event.touches[0]!;
    gesture = { id: touch.identifier, lastY: touch.clientY, remainder: 0 };
  };

  const move = (event: TouchEvent) => {
    if (gesture === undefined || deferToProgram()) return;
    const touch = Array.from(event.touches).find(candidate => candidate.identifier === gesture!.id);
    if (touch === undefined) return;
    // Dragging the finger down (clientY increasing) reveals older output, i.e. scrolls
    // the buffer up; `scrollLines` counts down as positive.
    gesture.remainder += touch.clientY - gesture.lastY;
    gesture.lastY = touch.clientY;
    const lines = Math.trunc(gesture.remainder / cellHeight());
    if (lines !== 0) {
      gesture.remainder -= lines * cellHeight();
      terminal.scrollLines(-lines);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  const end = (event: TouchEvent) => {
    if (gesture !== undefined && !Array.from(event.touches).some(candidate => candidate.identifier === gesture!.id)) {
      gesture = undefined;
    }
  };

  const options = { capture: true, passive: false } as const;
  element.addEventListener('touchstart', start, options);
  element.addEventListener('touchmove', move, options);
  element.addEventListener('touchend', end, options);
  element.addEventListener('touchcancel', end, options);

  return () => {
    element.removeEventListener('touchstart', start, options);
    element.removeEventListener('touchmove', move, options);
    element.removeEventListener('touchend', end, options);
    element.removeEventListener('touchcancel', end, options);
  };
};
