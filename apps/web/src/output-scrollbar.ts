// keep the handle narrow beside output controls and restore its native width elsewhere
export function attachOutputScrollbar(container: HTMLElement): () => void {
  const output = container.closest<HTMLElement>('.log-output');
  const controls = output?.querySelector<HTMLElement>('.page-controls');
  const track = container.querySelector<HTMLElement>('.xterm-scrollable-element > .scrollbar.vertical');
  const slider = track?.querySelector<HTMLElement>('.slider');
  // embedded output has no right-side controls to avoid
  if (!output || !controls || !track || !slider) return () => { /* nothing mounted */ };
  let frame: number | undefined;

  // compare the whole thumb against the live button stack, not a fixed button count
  const sync = () => {
    frame = undefined;
    const thumb = slider.getBoundingClientRect();
    const rail = controls.getBoundingClientRect();
    const native = track.getBoundingClientRect();
    const overlaps = rail.width > 0 && rail.height > 0
      && thumb.bottom > rail.top && thumb.top < rail.bottom
      && native.right > rail.left && native.left < rail.right;
    slider.classList.toggle('output-controls-overlap', overlaps);
  };
  // coalesce scroll and layout notifications before the next paint
  const schedule = () => {
    // reuse a pending geometry read
    if (frame === undefined) frame = window.requestAnimationFrame(sync);
  };
  // xterm changes the thumb's inline top and height while scrolling
  const positionObserver = new MutationObserver(schedule);
  positionObserver.observe(slider, { attributes: true, attributeFilter: ['style'] });
  // include dynamic buttons and viewport or split-panel resizing
  const layoutObserver = new ResizeObserver(schedule);
  layoutObserver.observe(controls);
  layoutObserver.observe(output);
  layoutObserver.observe(track);
  sync();

  // release observers before the terminal is removed or replaced
  return () => {
    positionObserver.disconnect();
    layoutObserver.disconnect();
    // discard a queued layout read
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    slider.classList.remove('output-controls-overlap');
  };
}
