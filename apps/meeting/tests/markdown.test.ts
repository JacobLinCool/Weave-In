import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('participant Markdown', () => {
  it('renders headings, lists, tables, code, task lists, and ordinary chat line breaks', () => {
    const html = render('# Agenda\n\n**Review** and ~~old~~\nnext line\n\n- [x] Ready\n- Pending\n\n| Topic | Owner |\n| --- | --- |\n| Preview | Alex |\n\n```js\nconst value = "<script>";\n```');
    expect(html).toContain('<h1>Agenda</h1>');
    expect(html).toContain('<strong>Review</strong>');
    expect(html).toContain('<del>old</del><br/>');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('<th>Topic</th>');
    expect(html).toContain('class="language-js"');
    expect(html).toContain('&lt;script&gt;');
  });

  it('does not execute participant HTML or unsafe links', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[bad](javascript:alert%281%29) [data](data:text/html,boom) [relative](/api/transcription-token)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href=');
    expect(html).not.toContain('onerror');
  });

  it('opens safe links separately and never fetches remote Markdown images', () => {
    const html = render('[Reference](https://example.com) ![Chart](https://example.com/tracker.png)');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('rel="preload"');
    expect(html).toContain('>Chart</a>');
  });
});
