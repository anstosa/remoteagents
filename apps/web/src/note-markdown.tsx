import { Fragment, type ReactNode } from 'react';

const safeLink = (value: string) => /^(?:https?:|mailto:)/iu.test(value) ? value : undefined;
const inlinePattern = /(`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_)/gu;

const inlineMarkdown = (text: string, key: string): ReactNode[] => {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) content.push(text.slice(cursor, index));
    if (match[2] !== undefined) content.push(<code key={`${key}-${index}`}>{match[2]}</code>);
    else if (match[3] !== undefined && match[4] !== undefined) {
      const href = safeLink(match[4]);
      content.push(href === undefined ? match[3] : <a key={`${key}-${index}`} href={href} target="_blank" rel="noreferrer">{match[3]}</a>);
    } else if (match[5] !== undefined || match[6] !== undefined) content.push(<strong key={`${key}-${index}`}>{match[5] ?? match[6]}</strong>);
    else if (match[7] !== undefined) content.push(<del key={`${key}-${index}`}>{match[7]}</del>);
    else content.push(<em key={`${key}-${index}`}>{match[8] ?? match[9]}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return content;
};

const startsBlock = (line: string) => /^(?:\s*$|#{1,6}\s+|```|>\s?|[-*+]\s+|\d+[.)]\s+|(?:-{3,}|\*{3,}|_{3,})\s*$)/u.test(line);

type TableColumn = { start: number; end?: number };

const tableDividerColumns = (line: string, header = false): TableColumn[] | undefined => {
  if (header && !/[━═]/u.test(line)) return undefined;
  if (!/^[━─═\s]+$/u.test(line)) return undefined;
  const runs = [...line.matchAll(/[━─═]{3,}/gu)];
  if (runs.length < 2) return undefined;
  return runs.map((run, index) => ({ start: run.index, end: runs[index + 1]?.index }));
};

const tableCells = (lines: string[], columns: TableColumn[]) => columns.map(column => lines
  .map(line => line.slice(column.start, column.end).trim())
  .filter(Boolean)
  .join(' '));

const pseudoTable = (lines: string[], start: number): { block: ReactNode; next: number } | undefined => {
  let headerRule = start + 1;
  while (headerRule < Math.min(lines.length, start + 4) && lines[headerRule]!.trim()) {
    const columns = tableDividerColumns(lines[headerRule]!, true);
    if (columns !== undefined) {
      const headers = tableCells(lines.slice(start, headerRule), columns);
      if (headers.some(header => !header)) return undefined;
      const rows: string[][] = [];
      let rowLines: string[] = [];
      let index = headerRule + 1;
      const finishRow = () => {
        if (rowLines.length === 0) return;
        const cells = tableCells(rowLines, columns);
        if (cells.some(Boolean)) rows.push(cells);
        rowLines = [];
      };
      while (index < lines.length && lines[index]!.trim()) {
        if (tableDividerColumns(lines[index]!) !== undefined) finishRow();
        else rowLines.push(lines[index]!);
        index += 1;
      }
      finishRow();
      if (rows.length === 0) return undefined;
      return {
        block: <div className="note-table-scroll" key={`table-${start}`}><table><thead><tr>{headers.map((header, column) => <th key={`head-${column}`}>{inlineMarkdown(header, `table-head-${start}-${column}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{row.map((cell, column) => <td key={`cell-${column}`}>{inlineMarkdown(cell, `table-cell-${start}-${rowIndex}-${column}`)}</td>)}</tr>)}</tbody></table></div>,
        next: index
      };
    }
    headerRule += 1;
  }
  return undefined;
};

function MarkdownBlocks({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const blocks: ReactNode[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index += 1; continue; }
    const table = pseudoTable(lines, index);
    if (table !== undefined) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    const fence = /^```([^\s`]*)\s*$/u.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index]!)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(<pre key={`code-${index}`}><code data-language={fence[1] || undefined}>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const children = inlineMarkdown(heading[2]!, `heading-${index}`);
      blocks.push(level === 1 ? <h1 key={`heading-${index}`}>{children}</h1> : level === 2 ? <h2 key={`heading-${index}`}>{children}</h2> : level === 3 ? <h3 key={`heading-${index}`}>{children}</h3> : level === 4 ? <h4 key={`heading-${index}`}>{children}</h4> : level === 5 ? <h5 key={`heading-${index}`}>{children}</h5> : <h6 key={`heading-${index}`}>{children}</h6>);
      index += 1;
      continue;
    }
    if (/^(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { blocks.push(<hr key={`rule-${index}`} />); index += 1; continue; }
    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^>\s?/u.test(lines[index]!)) quote.push(lines[index++]!.replace(/^>\s?/u, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{quote.map((value, quoteIndex) => <Fragment key={`quote-line-${quoteIndex}`}>{quoteIndex > 0 && <br />}{inlineMarkdown(value, `quote-${index}-${quoteIndex}`)}</Fragment>)}</blockquote>);
      continue;
    }
    if (/^[-*+]\s+/u.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = /^[-*+]\s+(?:\[([ xX])\]\s+)?(.+)$/u.exec(lines[index]!);
        if (!item) break;
        items.push(<li key={`item-${index}`}>{item[1] !== undefined && <input type="checkbox" checked={item[1].toLowerCase() === 'x'} readOnly tabIndex={-1} />}{inlineMarkdown(item[2]!, `item-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ul key={`list-${index}`}>{items}</ul>);
      continue;
    }
    if (/^\d+[.)]\s+/u.test(line)) {
      const items: ReactNode[] = [];
      while (index < lines.length) {
        const item = /^\d+[.)]\s+(.+)$/u.exec(lines[index]!);
        if (!item) break;
        items.push(<li key={`ordered-${index}`}>{inlineMarkdown(item[1]!, `ordered-${index}`)}</li>);
        index += 1;
      }
      blocks.push(<ol key={`ordered-list-${index}`}>{items}</ol>);
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!.trim());
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdown(paragraph.join(' '), `paragraph-${index}`)}</p>);
  }
  return <>{blocks}</>;
}

export function NoteMarkdown({ text, onEdit }: { text: string; onEdit: () => void }) {
  return <div className="note-markdown" role="document" aria-label="Note preview" tabIndex={0} onFocus={event => { if (event.target === event.currentTarget) onEdit(); }} onClick={event => { if (!(event.target instanceof Element) || !event.target.closest('a')) onEdit(); }}><MarkdownBlocks text={text} /></div>;
}
