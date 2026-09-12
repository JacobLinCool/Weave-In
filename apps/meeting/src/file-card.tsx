import { Download, Eye, File, FileText, Image, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, type SharedFile } from './file-share';
import { FilePreview } from './file-preview';
import { previewFormat, previewLimit, type PreviewKind } from './preview-format';

export function FileCard({ file, onDownload }: { file: SharedFile | undefined; onDownload(id: string): void }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  if (!file) return <div className="file-card is-missing">This file is no longer listed.</div>;
  const format = previewFormat(file);
  const supported = format && file.size <= previewLimit(format.kind);
  const Icon = format?.kind === 'image' ? Image : format ? FileText : File;
  const canFetch = file.status === 'available' || file.status === 'error';
  const limitation = !format ? 'Preview unavailable' : !supported ? `Preview limit: ${formatBytes(previewLimit(format.kind))}` : null;
  return (
    <div className={`file-card is-${file.status}`} data-testid="file-card" data-status={file.status}>
      <div className="file-card__summary">
        <Icon size={18} className="file-card__icon" aria-hidden="true" />
        <div className="file-card__body">
          <span className="file-card__name" title={file.name}>{file.name}</span>
          <span className="file-card__meta">{formatBytes(file.size)}{limitation && ` · ${limitation}`}{file.error && ` · ${file.error}`}</span>
          {file.status === 'downloading' && <TransferProgress file={file} />}
        </div>
      </div>
      <div className="file-card__actions">
        {supported && <button
          type="button" className="file-card__action" aria-haspopup="dialog"
          disabled={!file.blob && file.status === 'unavailable'}
          onClick={() => { setPreviewOpen(true); if (canFetch) onDownload(file.id); }}
        ><Eye size={14} /> Preview</button>}
        {file.blob ? <button type="button" className="file-card__action file-card__action--icon" aria-label={`Save ${file.name}`} title="Save file" onClick={() => saveBlob(file.blob!, file.name)}><Download size={14} /></button>
          : canFetch && <button type="button" className="file-card__action file-card__action--icon" aria-label={`${file.status === 'error' ? 'Retry download' : 'Download'} ${file.name}`} title={file.status === 'error' ? 'Retry download' : 'Download file'} onClick={() => onDownload(file.id)}><Download size={14} /></button>}
      </div>
      {previewOpen && supported && createPortal(
        <PreviewDialog file={file} kind={format.kind} mime={format.mime} onDownload={onDownload} onClose={() => setPreviewOpen(false)} />,
        document.body,
      )}
    </div>
  );
}

function TransferProgress({ file }: { file: SharedFile }) {
  const percent = file.size > 0 ? Math.min(100, Math.floor(file.received / file.size * 100)) : 0;
  return <div className="file-transfer-progress">
    <span className="file-card__meta">{formatBytes(file.received)} of {formatBytes(file.size)} · {percent}%</span>
    <span className="file-card__progress" role="progressbar" aria-label={`Receiving ${file.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{ width: `${percent}%` }} /></span>
  </div>;
}

function PreviewDialog({ file, kind, mime, onDownload, onClose }: { file: SharedFile; kind: PreviewKind; mime: string; onDownload(id: string): void; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog ref={dialog} className="preview-dialog" aria-label={`Preview ${file.name}`} onClose={onClose}
    onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}>
    <header className="preview-dialog__header">
      <div className="preview-dialog__title"><h2>{file.name}</h2><span className="file-card__meta">{formatBytes(file.size)}</span></div>
      {file.blob && <button type="button" className="file-card__action" onClick={() => saveBlob(file.blob!, file.name)}><Download size={14} /> Save</button>}
      <button type="button" className="file-card__action file-card__action--icon" onClick={() => dialog.current?.close()} aria-label="Close preview" autoFocus><X size={18} /></button>
    </header>
    {file.blob ? <FilePreview blob={file.blob} name={file.name} kind={kind} mime={mime} />
      : <div className="preview-dialog__status">
        {file.status === 'available' || file.status === 'error' || file.status === 'unavailable' ? <>
          <p role={file.status === 'available' ? 'status' : 'alert'}>{file.status === 'available'
            ? 'This file is available. Load it to preview.'
            : file.error ?? 'This file is no longer available.'}</p>
          {file.status !== 'unavailable' && <button type="button" className="file-card__action" onClick={() => onDownload(file.id)}>{file.status === 'available' ? 'Load preview' : 'Retry preview'}</button>}
        </> : <>
          <p role="status">Receiving file for preview…</p>
          <TransferProgress file={file} />
        </>}
      </div>}
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
