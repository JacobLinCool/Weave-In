import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { useEffect, useRef, useState } from 'react';

GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfPreview({ blob }: { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    let task: ReturnType<typeof getDocument> | undefined;
    void blob.arrayBuffer().then(async (data) => {
      if (cancelled) return;
      task = getDocument({
        data, useWasm: false,
        cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/',
      });
      const document = await task.promise;
      if (!cancelled) setPdf(document);
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error && reason.name === 'PasswordException'
        ? 'This PDF needs a password. Save it to open it in your PDF reader.'
        : 'This PDF could not be previewed. You can still save the file.');
    });
    return () => { cancelled = true; void task?.destroy(); };
  }, [blob]);
  if (error) return <p role="alert">{error}</p>;
  if (!pdf) return <p role="status">Loading PDF…</p>;
  return (
    <div className="pdf-preview">
      <nav className="pdf-preview__controls" aria-label="PDF pages">
        <button type="button" disabled={pageNumber === 1} onClick={() => setPageNumber((page) => page - 1)}>Previous</button>
        <span aria-live="polite">Page {pageNumber} of {pdf.numPages}</span>
        <button type="button" disabled={pageNumber === pdf.numPages} onClick={() => setPageNumber((page) => page + 1)}>Next</button>
      </nav>
      <PdfPage key={pageNumber} pdf={pdf} pageNumber={pageNumber} />
    </div>
  );
}

function PdfPage({ pdf, pageNumber }: { pdf: PDFDocumentProxy; pageNumber: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let render: RenderTask | undefined;
    void pdf.getPage(pageNumber).then(async (page) => {
      const target = canvas.current;
      if (cancelled || !target) return;
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(2, 1400 / Math.max(base.width, base.height)) });
      target.width = Math.ceil(viewport.width);
      target.height = Math.ceil(viewport.height);
      render = page.render({ canvas: target, viewport });
      await render.promise;
      if (cancelled) return;
      setLoading(false);
      const content = await page.getTextContent();
      if (!cancelled) setText(content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join(''));
    }).catch(() => { if (!cancelled) { setFailed(true); setLoading(false); } });
    return () => { cancelled = true; render?.cancel(); };
  }, [pdf, pageNumber]);
  return <>
    {loading && <p role="status">Rendering page…</p>}
    {failed && <p role="alert">This page could not be rendered.</p>}
    <canvas ref={canvas} role="img" aria-label={`PDF page ${pageNumber}`} hidden={loading || failed} />
    {text.trim() && <details><summary>Page text</summary><pre className="file-preview__text">{text}</pre></details>}
  </>;
}
