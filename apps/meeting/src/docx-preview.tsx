import DOMPurify from 'dompurify';
import mammoth from 'mammoth';
import { useEffect, useState } from 'react';
import { safeContentUrl } from './markdown';

export default function DocxPreview({ blob }: { blob: Blob }) {
  const [html, setHtml] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void blob.arrayBuffer().then((arrayBuffer) => mammoth.convertToHtml({ arrayBuffer }, {
      externalFileAccess: false,
      // Document previews retain text structure without loading embedded or linked images.
      convertImage: mammoth.images.imgElement(async () => ({ src: '' })),
    })).then(({ value }) => {
      const fragment = DOMPurify.sanitize(value, {
        ALLOWED_TAGS: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'blockquote'],
        ALLOWED_ATTR: ['href', 'title', 'colspan', 'rowspan', 'start'],
        RETURN_DOM_FRAGMENT: true,
      });
      for (const link of fragment.querySelectorAll('a')) {
        const href = safeContentUrl(link.getAttribute('href') ?? '');
        if (href) {
          link.setAttribute('href', href);
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        } else link.removeAttribute('href');
      }
      const container = document.createElement('div');
      container.appendChild(fragment);
      if (!cancelled) setHtml(container.innerHTML);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [blob]);
  if (failed) return <p role="alert">This document could not be previewed. You can still save the file.</p>;
  if (html === undefined) return <p role="status">Loading document…</p>;
  if (!html) return <p>This document has no text to preview.</p>;
  return <div className="markdown-body document-preview" dangerouslySetInnerHTML={{ __html: html }} />;
}
