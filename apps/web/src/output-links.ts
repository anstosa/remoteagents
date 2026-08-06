import type { IBufferRange, Terminal as XTerm } from '@xterm/xterm';

const outputUrl = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~\[\]`()<>]/;
const outputUrlContinuation = /^[^\s"'!*(){}|\\^<>`]/;

export type OutputLink = { uri: string; range: IBufferRange };
export type OutputLinkSegment = { column: number; row: number; columns: number };

const outputLinkPosition = (terminal: XTerm, initialLine: number, initialColumn: number, length: number): [number, number] => {
  const buffer = terminal.buffer.active;
  const cell = buffer.getNullCell();
  let line = initialLine;
  let column = initialColumn;
  while (length > 0) {
    const row = buffer.getLine(line);
    if (!row) return [-1, -1];
    for (; column < row.length; column += 1) {
      row.getCell(column, cell);
      const chars = cell.getChars();
      if (cell.getWidth()) {
        length -= chars.length || 1;
        if (column === row.length - 1 && !chars && buffer.getLine(line + 1)?.isWrapped && buffer.getLine(line + 1)?.getCell(0, cell)?.getWidth() === 2) length += 1;
      }
      if (length < 0) return [line, column];
    }
    line += 1;
    column = 0;
  }
  return [line, column];
};

const lineEndsAtRightEdge = (terminal: XTerm, line: number) => {
  const row = terminal.buffer.active.getLine(line);
  const cell = row?.getCell((row.length ?? 0) - 1);
  return cell !== undefined && cell.getWidth() > 0 && cell.getChars() !== '';
};

const urlReachesEnd = (text: string) => {
  const matcher = new RegExp(outputUrl.source, 'g');
  for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
    if (match.index + match[0].length === text.length) return true;
  }
  return false;
};

export const terminalOutputLinks = (terminal: XTerm): OutputLink[] => {
  const buffer = terminal.buffer.active;
  const links: OutputLink[] = [];
  for (let first = 0; first < buffer.length;) {
    let last = first;
    let text = buffer.getLine(first)?.translateToString(true) ?? '';
    while (last + 1 < buffer.length) {
      const next = buffer.getLine(last + 1);
      const nextText = next?.translateToString(true) ?? '';
      if (!next?.isWrapped && !(lineEndsAtRightEdge(terminal, last) && urlReachesEnd(text) && outputUrlContinuation.test(nextText))) break;
      last += 1;
      text += nextText;
    }
    const matcher = new RegExp(outputUrl.source, 'g');
    for (let match = matcher.exec(text); match !== null; match = matcher.exec(text)) {
      const [startLine, startColumn] = outputLinkPosition(terminal, first, 0, match.index);
      const [endLine, endColumn] = outputLinkPosition(terminal, startLine, startColumn, match[0].length);
      if (startLine < 0 || endLine < 0) continue;
      links.push({ uri: match[0], range: { start: { x: startColumn + 1, y: startLine + 1 }, end: { x: endColumn, y: endLine + 1 } } });
    }
    first = last + 1;
  }
  return links;
};

export const outputLinkSegments = (range: IBufferRange, columns: number, rows: number, viewportY: number): OutputLinkSegment[] => {
  const firstVisibleLine = viewportY + 1;
  const lastVisibleLine = viewportY + rows;
  const firstLine = Math.max(range.start.y, firstVisibleLine);
  const lastLine = Math.min(range.end.y, lastVisibleLine);
  const segments: OutputLinkSegment[] = [];
  for (let line = firstLine; line <= lastLine; line += 1) {
    const column = line === range.start.y ? range.start.x - 1 : 0;
    const end = line === range.end.y ? range.end.x : columns;
    if (end > column) segments.push({ column, row: line - firstVisibleLine, columns: end - column });
  }
  return segments;
};

export const createOutputLinkOverlays = (container: HTMLElement, onOpen: () => void) => {
  const anchors = new Map<string, HTMLAnchorElement>();
  const clear = () => {
    anchors.forEach(anchor => anchor.remove());
    anchors.clear();
  };
  const render = (terminal: XTerm) => {
    const element = terminal.element;
    const screen = element?.querySelector<HTMLElement>('.xterm-screen');
    if (!element || !screen) return clear();
    const containerBounds = container.getBoundingClientRect();
    const screenBounds = screen.getBoundingClientRect();
    if (!screenBounds.width || !screenBounds.height || !terminal.cols || !terminal.rows) return clear();
    const cellWidth = screenBounds.width / terminal.cols;
    const cellHeight = screenBounds.height / terminal.rows;
    const active = new Set<string>();
    for (const link of terminalOutputLinks(terminal)) {
      const segments = outputLinkSegments(link.range, terminal.cols, terminal.rows, terminal.buffer.active.viewportY);
      segments.forEach((segment, index) => {
        const key = `${link.uri}\0${segment.column}:${segment.row}:${segment.columns}:${index}`;
        active.add(key);
        let anchor = anchors.get(key);
        if (anchor === undefined) {
          anchor = document.createElement('a');
          anchor.className = 'output-link-overlay';
          anchor.href = link.uri;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.title = link.uri;
          anchor.setAttribute('aria-label', `Open ${link.uri}`);
          anchor.style.position = 'absolute';
          anchor.style.zIndex = '10';
          anchor.style.display = 'block';
          anchor.style.background = 'transparent';
          anchor.style.cursor = 'pointer';
          anchor.addEventListener('mousedown', event => event.stopPropagation());
          anchor.addEventListener('mouseup', event => event.stopPropagation());
          anchor.addEventListener('click', event => { event.stopPropagation(); onOpen(); });
          container.append(anchor);
          anchors.set(key, anchor);
        }
        anchor.style.left = `${screenBounds.left - containerBounds.left + segment.column * cellWidth}px`;
        anchor.style.top = `${screenBounds.top - containerBounds.top + segment.row * cellHeight}px`;
        anchor.style.width = `${segment.columns * cellWidth}px`;
        anchor.style.height = `${cellHeight}px`;
      });
    }
    for (const [key, anchor] of anchors) if (!active.has(key)) {
      anchor.remove();
      anchors.delete(key);
    }
  };
  return { render, clear };
};
