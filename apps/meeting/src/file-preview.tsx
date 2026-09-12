import { Component, lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Markdown } from './markdown';
import type { PreviewKind } from './preview-format';

const PdfPreview = lazy(() => import('./pdf-preview'));
const DocxPreview = lazy(() => import('./docx-preview'));

export function FilePreview({ blob, kind, mime, name }: { blob: Blob; kind: PreviewKind; mime: string; name: string }) {
  return (
    <div className="file-preview" data-testid="file-preview">
      <PreviewBoundary><Suspense fallback={<p role="status">Loading preview…</p>}>
        {kind === 'image' ? <ImagePreview blob={blob} mime={mime} name={name} />
          : kind === 'pdf' ? <PdfPreview blob={blob} />
          : kind === 'docx' ? <DocxPreview blob={blob} />
          : <TextPreview blob={blob} markdown={kind === 'markdown'} />}
      </Suspense></PreviewBoundary>
    </div>
  );
}

function ImagePreview({ blob, mime, name }: { blob: Blob; mime: string; name: string }) {
  const [url, setUrl] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const objectUrl = URL.createObjectURL(blob.slice(0, blob.size, mime));
    setUrl(objectUrl);
    setFailed(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob, mime]);
  return failed ? <p role="alert">This image could not be previewed. You can still save the file.</p>
    : <img src={url} alt={name} className="file-preview__image" onError={() => setFailed(true)} />;
}

function TextPreview({ blob, markdown }: { blob: Blob; markdown: boolean }) {
  const [text, setText] = useState<string>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void blob.arrayBuffer().then((bytes) => {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (content.includes('\0')) throw new Error('Binary content');
      if (!cancelled) setText(content);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [blob]);
  if (failed) return <p role="alert">This file is not readable UTF-8 text. You can still save it.</p>;
  if (text === undefined) return <p role="status">Loading preview…</p>;
  if (!text.trim()) return <p>This document is empty.</p>;
  return markdown ? <Markdown text={text} /> : <pre className="file-preview__text">{text}</pre>;
}

class PreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() {
    return this.state.failed ? <p role="alert">Preview could not be loaded. Hide it and try again, or save the file.</p> : this.props.children;
  }
}
