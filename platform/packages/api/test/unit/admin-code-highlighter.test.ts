import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vite-plus/test';
import { highlightCode } from '../../src/admin/react/code-highlighter.ts';
import { CodeBlock } from '../../src/admin/react/views/CodeBlock.tsx';

describe('admin code highlighting', () => {
  test('renders escaped, complete code on the server without initializing highlighting', () => {
    const code = JSON.stringify({ value: '</code><script>alert(1)</script>' }, null, 2);
    const html = renderToStaticMarkup(createElement(CodeBlock, { code, language: 'json' }));
    expect(html).toContain('data-language="json"');
    expect(html).toContain('&lt;/code&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<span');
    expect(html).toContain('\n  &quot;value&quot;:');
  });

  test('preserves JSON text and uses Licht/Dunkel token colors', () => {
    const code = JSON.stringify(
      { name: 'ß </code><script>alert(1)</script>', count: 42, ok: true },
      null,
      2,
    );
    const lines = highlightCode(code, 'json');
    expect(lines.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
    const tokens = lines.flat();
    expect(tokens.find((token) => token.content === '42')?.style.color).toBe(
      'light-dark(#DD3C2F, #DB584D)',
    );
    expect(tokens.find((token) => token.content === 'true')?.style.color).toBe(
      'light-dark(#626FC9, #7B8CFD)',
    );
    expect(tokens.some((token) => token.style.color === 'light-dark(#00A33F, #52CE81)')).toBe(true);
  });

  test('highlights CLI snippets and preserves whitespace and placeholders', () => {
    const code = 'void platform config auth protection enable --installation <id>\n\n';
    const lines = highlightCode(code, 'shellscript');
    expect(lines.map((line) => line.map((token) => token.content).join('')).join('\n')).toBe(code);
    expect(new Set(lines.flat().map((token) => token.style.color)).size).toBeGreaterThan(1);
  });
});
