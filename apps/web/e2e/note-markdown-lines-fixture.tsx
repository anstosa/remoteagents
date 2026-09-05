import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { NoteMarkdown } from '../src/note-markdown.js';

// render one isolated note preview
export const renderNoteMarkdownLines = (root: HTMLElement, text: string) => {
  createRoot(root).render(createElement(NoteMarkdown, { text }));
};
