type OutputLongPressOptions = {
  holdMilliseconds?: number;
  moveTolerance?: number;
};

export function preserveOutputLongPressSelection(
  element: HTMLElement,
  onLongPress: () => void,
  { holdMilliseconds = 350, moveTolerance = 10 }: OutputLongPressOptions = {}
) {
  let timer: number | undefined;
  let pointer: { id: number; x: number; y: number } | undefined;
  let longPressTriggered = false;
  let consumeClick = false;

  const resetGesture = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    pointer = undefined;
    longPressTriggered = false;
  };
  const triggerLongPress = () => {
    if (longPressTriggered) return;
    longPressTriggered = true;
    consumeClick = true;
    onLongPress();
  };
  const start = (event: PointerEvent) => {
    if (event.pointerType === 'mouse') return;
    resetGesture();
    // If the browser did not emit a click for the previous gesture, this
    // pointerdown definitively starts a new gesture and clears the stale guard.
    consumeClick = false;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    timer = window.setTimeout(() => {
      timer = undefined;
      if (pointer?.id === event.pointerId) triggerLongPress();
    }, holdMilliseconds);
  };
  const move = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > moveTolerance) resetGesture();
  };
  const end = (event: PointerEvent) => {
    if (pointer?.id === event.pointerId) resetGesture();
  };
  const cancel = (event: PointerEvent) => {
    if (pointer?.id !== event.pointerId) return;
    // Mobile browsers may cancel the pointer when they take ownership of a
    // long press to start native text selection. Keep the gesture timer and
    // click guard alive so that handoff cannot become an output-mode tap.
  };
  const selectionStart = () => {
    if (pointer !== undefined) triggerLongPress();
  };
  const click = (event: MouseEvent) => {
    if (!consumeClick) return;
    consumeClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const isolateXtermFocus = (event: MouseEvent | TouchEvent) => {
    if (window.matchMedia('(pointer: coarse)').matches) event.stopPropagation();
  };

  element.addEventListener('pointerdown', start);
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', end);
  element.addEventListener('pointercancel', cancel);
  element.addEventListener('selectionstart', selectionStart);
  element.addEventListener('click', click, true);
  element.addEventListener('mousedown', isolateXtermFocus, true);
  element.addEventListener('touchstart', isolateXtermFocus, true);
  element.addEventListener('contextmenu', isolateXtermFocus, true);

  return () => {
    resetGesture();
    consumeClick = false;
    element.removeEventListener('pointerdown', start);
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', end);
    element.removeEventListener('pointercancel', cancel);
    element.removeEventListener('selectionstart', selectionStart);
    element.removeEventListener('click', click, true);
    element.removeEventListener('mousedown', isolateXtermFocus, true);
    element.removeEventListener('touchstart', isolateXtermFocus, true);
    element.removeEventListener('contextmenu', isolateXtermFocus, true);
  };
}
