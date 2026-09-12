import type { CaptureOptions, CapturedFrame } from './screen-capture';

/** Capture the actual canvas pixels rendered by Excalidraw, without a second renderer. */
export async function captureWhiteboard(root: HTMLElement, options: CaptureOptions): Promise<CapturedFrame> {
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const source = root.querySelector<HTMLCanvasElement>('canvas.excalidraw__canvas.static');
  if (!source || !source.width || !source.height) throw new Error('Open the whiteboard before capturing it.');
  if (root.querySelector('textarea.excalidraw-wysiwyg')) throw new Error('Finish editing the text before capturing the committed canvas.');
  const sourceWidth = source.clientWidth, sourceHeight = source.clientHeight;
  const scale = Math.min(1, options.maxWidth/sourceWidth);
  const width = Math.round(sourceWidth*scale), height = Math.round(sourceHeight*scale);
  const canvas=document.createElement('canvas'); canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext('2d'); if (!ctx) throw new Error('Canvas is unavailable.');
  ctx.drawImage(source,0,0,width,height);
  const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(result=>result ? resolve(result) : reject(new Error('Could not encode the whiteboard.')),`image/${options.format}`,options.quality));
  return {blob,width,height,sourceWidth,sourceHeight};
}
