import { Download, Eye, File, FileText, Image, Maximize2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { formatBytes, type SharedFile } from './file-share';
import { FilePreview } from './file-preview';
import type { PreviewKind } from './preview-format';
import { AUTO_IMAGE_BYTES, previewFormat, previewLimit } from './preview-format';

export function FileCard({ file, onDownload }: { file: SharedFile | undefined; onDownload(id: string): void }) {
  const format = file ? previewFormat(file) : null;
  const automatic = format?.kind === 'image' && !!file && file.size <= AUTO_IMAGE_BYTES;
  const [expanded, setExpanded] = useState(automatic);
  const [enlarged, setEnlarged] = useState(false);
  const card = useRef<HTMLDivElement>(null);
  const fetchFile = useEffectEvent((id: string) => onDownload(id));
  const id = file?.id;
  const status = file?.status;
  // Fetch visible small images once; other previews load only on request.
  useEffect(() => {
    const target = card.current;
    if (!automatic || !target || !id || status !== 'available') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        observer.disconnect();
        fetchFile(id);
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [automatic, id, status]);

  if (!file) return <div className="file-card is-missing">This file is no longer listed.</div>;
  const supported = format && file.size <= previewLimit(format.kind);
  const Icon = format?.kind === 'image' ? Image : format ? FileText : File;
  const percent = file.size > 0 ? Math.min(100, Math.floor(file.received / file.size * 100)) : 0;
  const canFetch = file.status === 'available' || file.status === 'error';
  return (
    <div ref={card} className={`file-card is-${file.status}`} data-testid="file-card" data-status={file.status}>
      <div className="file-card__summary">
        <Icon size={18} className="file-card__icon" aria-hidden="true" />
        <div className="file-card__body">
          <span className="file-card__name" title={file.name}>{file.name}</span>
          <span className="file-card__meta">
            {file.status === 'downloading' ? `${formatBytes(file.received)} of ${formatBytes(file.size)} · ${percent}%` : formatBytes(file.size)}
            {file.error && ` · ${file.error}`}
          </span>
          {file.status === 'downloading' && <span className="file-card__progress" role="progressbar" aria-label={`Downloading ${file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>}
        </div>
      </div>
      <div className="file-card__actions">
        {supported && (file.blob || file.status !== 'unavailable') && <button
          type="button" className="file-card__action" aria-expanded={expanded}
          onClick={() => {
            if (file.status === 'error') { setExpanded(true); onDownload(file.id); }
            else { setExpanded(!expanded); if (!expanded && canFetch) onDownload(file.id); }
          }}
        >{expanded && file.status !== 'error' ? <X size={14} /> : <Eye size={14} />}{file.status === 'error' ? 'Retry preview' : expanded ? 'Hide preview' : 'Preview'}</button>}
        {supported && file.blob && <button type="button" className="file-card__action" onClick={() => setEnlarged(true)}><Maximize2 size={14} /> Expand</button>}
        {file.blob ? <button type="button" className="file-card__action" onClick={() => saveBlob(file.blob!, file.name)}><Download size={14} /> Save</button>
          : canFetch && <button type="button" className="file-card__action" onClick={() => onDownload(file.id)}><Download size={14} />{file.status === 'error' ? 'Retry download' : 'Download'}</button>}
      </div>
      {!supported && <p className="file-card__meta">{format ? `Preview available for files up to ${formatBytes(previewLimit(format.kind))}.` : 'Preview is not available for this file type.'}</p>}
      {enlarged && supported && file.blob && createPortal(<PreviewDialog file={file} blob={file.blob} kind={format.kind} mime={format.mime} onClose={() => setEnlarged(false)} />, document.body)}
      {expanded && !enlarged && supported && (file.blob
        ? <FilePreview key={file.id} blob={file.blob} name={file.name} kind={format.kind} mime={format.mime} />
        : file.status === 'downloading' ? <p className="file-card__meta" role="status">Receiving preview…</p> : null)}
    </div>
  );
}

function PreviewDialog({ file, blob, kind, mime, onClose }: { file: SharedFile; blob: Blob; kind: PreviewKind; mime: string; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="preview-dialog" aria-label={`Preview ${file.name}`} onClose={onClose}>
    <header className="preview-dialog__header">
      <h2>{file.name}</h2>
      <button type="button" className="file-card__action" onClick={() => saveBlob(blob, file.name)}><Download size={14} /> Save</button>
      <button type="button" className="file-card__action" onClick={onClose} aria-label="Close preview" autoFocus><X size={16} /></button>
    </header>
    <FilePreview blob={blob} name={file.name} kind={kind} mime={mime} />
  </dialog>;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
