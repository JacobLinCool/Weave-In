import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

/** Links in participant content must not execute code or navigate the meeting. */
export function safeContentUrl(url: string): string {
  return /^(?:https?:\/\/|mailto:)/iu.test(url) ? url : '';
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        urlTransform={safeContentUrl}
        components={{
          a: ({ href, children, title }) => href
            ? <a href={href} title={title} target="_blank" rel="noopener noreferrer">{children}</a>
            : <span>{children}</span>,
          // Remote images in messages remain links; shared images use the P2P preview.
          img: ({ src, alt }) => src
            ? <a href={src} target="_blank" rel="noopener noreferrer">{alt || 'Image'}</a>
            : <span>{alt}</span>,
          table: ({ children }) => <div className="markdown-table"><table>{children}</table></div>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
}
