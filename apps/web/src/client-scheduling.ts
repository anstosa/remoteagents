export const pollWhileVisible = (task: () => void | Promise<void>, intervalMs: number, immediate = true, hiddenIntervalMs?: number) => {
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let timer: number | undefined;

  const clearTimer = () => {
    if (timer === undefined) return;
    window.clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clearTimer();
    if (stopped) return;
    const delay = document.visibilityState === 'visible' ? intervalMs : hiddenIntervalMs;
    if (delay !== undefined) timer = window.setTimeout(() => void run(), delay);
  };
  const run = async () => {
    clearTimer();
    if (stopped || (document.visibilityState !== 'visible' && hiddenIntervalMs === undefined)) return;
    if (running) {
      rerunRequested ||= document.visibilityState === 'visible';
      return;
    }
    running = true;
    try { await task(); }
    finally {
      running = false;
      if (rerunRequested) {
        rerunRequested = false;
        void run();
      } else schedule();
    }
  };
  const visibilityChanged = () => {
    if (document.visibilityState === 'visible') void run();
    else schedule();
  };

  document.addEventListener('visibilitychange', visibilityChanged);
  if (immediate) void run();
  else schedule();

  return () => {
    stopped = true;
    clearTimer();
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
};

export const createAnimationFrameTextBatcher = (
  flush: (value: string) => void,
  schedule: (callback: FrameRequestCallback) => number = window.requestAnimationFrame.bind(window),
  cancel: (frame: number) => void = window.cancelAnimationFrame.bind(window),
  maxLength = Number.MAX_SAFE_INTEGER
) => {
  let frame: number | undefined;
  let pending = '';
  const clear = () => {
    pending = '';
    if (frame === undefined) return;
    cancel(frame);
    frame = undefined;
  };
  return {
    push(value: string) {
      if (pending.length + value.length > maxLength) return false;
      pending += value;
      if (frame === undefined) frame = schedule(() => {
        frame = undefined;
        const value = pending;
        pending = '';
        if (value) flush(value);
      });
      return true;
    },
    clear
  };
};
