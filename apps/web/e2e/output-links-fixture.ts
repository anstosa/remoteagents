import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { createOutputLinkOverlays } from '../src/output-links.js';
import '../src/styles.css';

let refreshTimer: number | undefined;
let terminal: XTerm | undefined;
let overlays: ReturnType<typeof createOutputLinkOverlays> | undefined;

export const renderOutputLinks = async (container: HTMLElement) => {
  container.style.position = 'relative';
  container.style.width = '800px';
  container.style.height = '200px';
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  container.append(host);
  const nextTerminal = new XTerm({ cols: 80, rows: 8, convertEol: true, fontSize: 14 });
  const nextOverlays = createOutputLinkOverlays(container, () => { document.body.dataset.opened = 'true'; });
  terminal = nextTerminal;
  overlays = nextOverlays;
  nextTerminal.open(host);
  await new Promise<void>(resolve => nextTerminal.write('Visit https://example.com/output for details.', () => {
    nextOverlays.render(nextTerminal);
    container.dataset.ready = 'true';
    resolve();
  }));
};

export const renderCapturedWrappedOutputLink = async (container: HTMLElement) => {
  container.style.position = 'relative';
  container.style.width = '360px';
  container.style.height = '200px';
  const host = document.createElement('div');
  host.style.position = 'absolute';
  host.style.inset = '0';
  container.append(host);
  const uri = 'https://example.com/a/very/long/path?item=12345';
  const nextTerminal = new XTerm({ cols: 30, rows: 8, convertEol: true, fontSize: 14 });
  const nextOverlays = createOutputLinkOverlays(container, () => { document.body.dataset.opened = 'true'; });
  nextTerminal.open(host);
  const firstLine = `Visit ${uri.slice(0, 24)}`;
  const secondLine = `${uri.slice(24)} for details.`;
  await new Promise<void>(resolve => nextTerminal.write(`${firstLine}\x1b[K\n${secondLine}`, () => {
    nextOverlays.render(nextTerminal);
    container.dataset.uri = uri;
    container.dataset.ready = 'true';
    resolve();
  }));
};

export const startOutputLinkRefresh = () => {
  if (!terminal || !overlays) return;
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = window.setInterval(() => overlays?.render(terminal!), 20);
};

export const stopOutputLinkRefresh = () => {
  if (refreshTimer !== undefined) window.clearInterval(refreshTimer);
  refreshTimer = undefined;
};
