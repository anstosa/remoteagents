export function containOutputScroll(element: HTMLElement) {
  const contain = (event: Event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const options = { capture: true, passive: false } as const;

  element.addEventListener('wheel', contain, options);
  element.addEventListener('touchmove', contain, options);

  return () => {
    element.removeEventListener('wheel', contain, options);
    element.removeEventListener('touchmove', contain, options);
  };
}
