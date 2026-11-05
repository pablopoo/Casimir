import type { CSSProperties } from 'react';

export type CodeLanguage = 'json' | 'shellscript' | 'text';
export type CodeToken = { content: string; style: CSSProperties };
export type CodeHighlighter = (
  code: string,
  language: Exclude<CodeLanguage, 'text'>,
) => Array<Array<CodeToken>>;

let highlighterLoader: (() => Promise<CodeHighlighter>) | undefined;

// Registered by the browser entry so the server's import graph excludes Shiki entirely.
export function configureCodeHighlighting(loader: () => Promise<CodeHighlighter>) {
  highlighterLoader = loader;
}

export async function loadCodeHighlighter() {
  return highlighterLoader ? await highlighterLoader() : null;
}
