import type { Terminal as XTerm } from '@xterm/xterm';

// keep browser ranges on owned nodes rather than xterm's replaceable render trees
export const createTerminalSelectionSurface = (terminal: XTerm) => {
  const surface = document.createElement('div');
  surface.className = 'terminal-selection-surface';
  surface.setAttribute('aria-hidden', 'true');
  // keep native hyperlink hover and click events inside xterm's linkifier boundary
  terminal.element!.querySelector('.xterm-screen')!.append(surface);
  const rows: Array<{ element: HTMLDivElement; text: string }> = [];
  let paused = false;

  // mirror visible cells only while no selection owns their node lifetime
  const render = () => {
    // queued xterm renders must not invalidate a browser range
    if (paused) return;
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen');
    // wait for the terminal's first measurable render
    if (screen === null || screen === undefined || !screen.clientWidth || !screen.clientHeight) return;
    surface.style.width = `${screen.clientWidth}px`;
    surface.style.fontFamily = terminal.options.fontFamily ?? '';
    surface.style.fontSize = `${terminal.options.fontSize}px`;
    surface.style.setProperty('--selection-cell-width', `${screen.clientWidth / terminal.cols}px`);
    surface.style.setProperty('--selection-cell-height', `${screen.clientHeight / terminal.rows}px`);
    // remove rows only after a terminal resize and outside selection mode
    while (rows.length > terminal.rows) rows.pop()!.element.remove();
    const buffer = terminal.buffer.active;
    const cell = buffer.getNullCell();
    // update changed rows without rebuilding the rest of the projection
    for (let index = 0; index < terminal.rows; index += 1) {
      let row = rows[index];
      // retain one stable element per visible row
      if (row === undefined) {
        const element = document.createElement('div');
        element.className = 'terminal-selection-row';
        surface.append(element);
        row = { element, text: '\0' };
        rows.push(row);
      }
      const line = buffer.getLine(buffer.viewportY + index);
      row.element.dataset.wrapped = String(line?.isWrapped === true);
      const text = line?.translateToString(true) ?? '';
      // retain text nodes when only colors or the cursor changed
      if (row.text === text) continue;
      row.text = text;
      const fragment = document.createDocumentFragment();
      let remaining = text.length;
      let asciiRun: HTMLSpanElement | undefined;
      let asciiColumns = 0;
      // use public cell widths so wide glyphs and combining characters stay aligned
      for (let column = 0; line !== undefined && column < terminal.cols && remaining > 0; column += 1) {
        line.getCell(column, cell);
        const width = cell.getWidth();
        // wide characters already occupy their trailing zero-width cell
        if (width === 0) continue;
        const characters = cell.getChars() || ' ';
        const ascii = width === 1 && characters.length === 1 && characters.charCodeAt(0) >= 32 && characters.charCodeAt(0) < 127;
        // keep ordinary words together and avoid one node per ascii character
        if (ascii && asciiRun !== undefined) {
          asciiRun.textContent += characters;
          asciiColumns += 1;
          asciiRun.style.width = `calc(var(--selection-cell-width) * ${asciiColumns})`;
        } else {
          const span = document.createElement('span');
          span.style.width = `calc(var(--selection-cell-width) * ${width})`;
          span.textContent = characters;
          fragment.append(span);
          asciiRun = ascii ? span : undefined;
          asciiColumns = ascii ? 1 : 0;
        }
        remaining -= characters.length;
      }
      row.element.replaceChildren(fragment);
    }
  };
  const renderSub = terminal.onRender(render);
  render();

  return {
    // refresh through the terminal's post-paint boundary when selection ends
    setPaused: (value: boolean) => {
      paused = value;
      // catch up without projecting a viewport the terminal has not painted yet
      if (!paused) terminal.refresh(0, terminal.rows - 1);
    },
    // release subscriptions before disposing the terminal
    dispose: () => {
      renderSub.dispose();
      surface.remove();
    }
  };
};
