import { Fragment, type ReactNode, type Ref } from 'react';

const safeLink = (value: string) => /^(?:https?:|mailto:)/iu.test(value) ? value : undefined;
const inlinePattern = /(`([^`\n]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_)/gu;
const bareLinkPattern = /(?:https?:\/\/|mailto:|www\.)[^\s<]+/giu;
const singleTildeListStrike = /(^|[^~])~([^~\n]+)~(?!~)/gu;

const trimLinkSuffix = (value: string) => {
  let end = value.length;
  while (end > 0 && /[.,!?;:]/u.test(value[end - 1]!)) end -= 1;
  for (const [closing, opening] of [[')', '('], [']', '['], ['}', '{']] as const) {
    while (value[end - 1] === closing && value.slice(0, end).split(closing).length > value.slice(0, end).split(opening).length) end -= 1;
  }
  return [value.slice(0, end), value.slice(end)] as const;
};

const linkifyText = (text: string, key: string): ReactNode[] => {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(bareLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) content.push(text.slice(cursor, index));
    const [label, suffix] = trimLinkSuffix(match[0]);
    const href = label.startsWith('www.') ? `https://${label}` : label;
    content.push(<a key={`${key}-link-${index}`} href={href} target="_blank" rel="noreferrer">{label}</a>);
    if (suffix) content.push(suffix);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  return content;
};

const inlineMarkdown = (text: string, key: string): ReactNode[] => {
  const content: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(inlinePattern)) {
    const index = match.index ?? 0;
    if (index > cursor) content.push(...linkifyText(text.slice(cursor, index), `${key}-${cursor}`));
    if (match[2] !== undefined) content.push(<code key={`${key}-${index}`}>{match[2]}</code>);
    else if (match[3] !== undefined && match[4] !== undefined) {
      const href = safeLink(match[4]);
      content.push(href === undefined ? match[3] : <a key={`${key}-${index}`} href={href} target="_blank" rel="noreferrer">{match[3]}</a>);
    } else if (match[5] !== undefined || match[6] !== undefined) content.push(<strong key={`${key}-${index}`}>{match[5] ?? match[6]}</strong>);
    else if (match[7] !== undefined) content.push(<del key={`${key}-${index}`}>{match[7]}</del>);
    else content.push(<em key={`${key}-${index}`}>{match[8] ?? match[9]}</em>);
    cursor = index + match[0].length;
  }
  if (cursor < text.length) content.push(...linkifyText(text.slice(cursor), `${key}-${cursor}`));
  return content;
};

// preserve source lines inside one paragraph
const inlineMarkdownLines = (lines: string[], key: string): ReactNode[] => lines.map((line, index) => <Fragment key={`${key}-line-${index}`}>{index > 0 && <br />}{inlineMarkdown(line, `${key}-line-${index}`)}</Fragment>);

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

type ListMarker = { indent: number; ordered: boolean; number?: number; checked?: boolean; text: string };
type ListItem = { marker: ListMarker; lines: string[]; children: ParsedList[] };
type ParsedList = { ordered: boolean; start?: number; items: ListItem[] };

const listMarker = (line: string): ListMarker | undefined => {
  const match = /^(\s*)(?:(\d+)[.)]|([-*+]))\s+(?:\[([ xX])\]\s+)?(.*)$/u.exec(line);
  if (!match) return undefined;
  const [, indentation = '', orderedNumber, , checkedMarker, text = ''] = match;
  return {
    indent: indentation.replace(/\t/gu, '    ').length,
    ordered: orderedNumber !== undefined,
    ...(orderedNumber === undefined ? {} : { number: Number(orderedNumber) }),
    ...(checkedMarker === undefined ? {} : { checked: checkedMarker.toLowerCase() === 'x' }),
    text
  };
};

const parseList = (lines: string[], start: number, first: ListMarker): { list: ParsedList; next: number } => {
  const indent = first.indent;
  const list: ParsedList = { ordered: first.ordered, ...(first.number === undefined ? {} : { start: first.number }), items: [] };
  let index = start;
  while (index < lines.length) {
    const marker = listMarker(lines[index] ?? '');
    if (marker === undefined || marker.indent !== indent || marker.ordered !== list.ordered) break;
    const item: ListItem = { marker, lines: [marker.text], children: [] };
    index += 1;
    let endList = false;
    while (index < lines.length) {
      if (!lines[index]!.trim()) {
        let next = index + 1;
        while (next < lines.length && !(lines[next] ?? '').trim()) next += 1;
        const nextMarker = next < lines.length ? listMarker(lines[next] ?? '') : undefined;
        if (nextMarker !== undefined && nextMarker.indent >= indent) {
          index = next;
          if (nextMarker.indent === indent) break;
          continue;
        }
        index = next;
        endList = true;
        break;
      }
      const nestedMarker = listMarker(lines[index] ?? '');
      if (nestedMarker !== undefined) {
        if (nestedMarker.indent === indent) break;
        if (nestedMarker.indent < indent) { endList = true; break; }
        const nested = parseList(lines, index, nestedMarker);
        item.children.push(nested.list);
        index = nested.next;
        continue;
      }
      const continuationIndent = /^\s*/u.exec(lines[index] ?? '')?.[0].replace(/\t/gu, '    ').length ?? 0;
      if (continuationIndent > indent) {
        item.lines.push((lines[index] ?? '').trim());
        index += 1;
        continue;
      }
      endList = true;
      break;
    }
    list.items.push(item);
    if (endList) break;
  }
  return { list, next: index };
};

// render nested lists with paired single-tilde compatibility
const renderList = (list: ParsedList, key: string): ReactNode => {
  const items = list.items.map((item, index) => <li key={`${key}-item-${index}`}>{item.marker.checked !== undefined && <input type="checkbox" checked={item.marker.checked} readOnly tabIndex={-1} />}{inlineMarkdown(item.lines.join(' ').replace(singleTildeListStrike, '$1~~$2~~'), `${key}-item-${index}`)}{item.children.map((child, childIndex) => renderList(child, `${key}-item-${index}-child-${childIndex}`))}</li>);
  return list.ordered ? <ol key={key} start={list.start}>{items}</ol> : <ul key={key}>{items}</ul>;
};

// render note markdown blocks
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
    const marker = listMarker(line);
    if (marker !== undefined) {
      const parsed = parseList(lines, index, marker);
      blocks.push(renderList(parsed.list, `list-${index}`));
      index = parsed.next;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!.trim());
    blocks.push(<p key={`paragraph-${index}`}>{inlineMarkdownLines(paragraph, `paragraph-${index}`)}</p>);
  }
  return <>{blocks}</>;
}

export function NoteMarkdown({ text, containerRef }: { text: string; containerRef?: Ref<HTMLDivElement> }) {
  return <div ref={containerRef} className="note-markdown" role="document" aria-label="Note preview" tabIndex={0}><MarkdownBlocks text={text} /></div>;
}
