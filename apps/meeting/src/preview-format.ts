import type { SharedFileMeta } from './protocol';

export type PreviewKind = 'image' | 'pdf' | 'docx' | 'markdown' | 'text';
export const TEXT_PREVIEW_BYTES = 1024 * 1024;
export const DOCUMENT_PREVIEW_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp',
};

export function previewFormat(file: Pick<SharedFileMeta, 'name' | 'mime'>): { kind: PreviewKind; mime: string } | null {
  const extension = file.name.split('.').at(-1)?.toLowerCase() ?? '';
  const mime = file.mime.split(';')[0]!.trim().toLowerCase();
  const imageMime = IMAGE_TYPES[extension] ?? Object.values(IMAGE_TYPES).find((value) => value === mime);
  if (imageMime) return { kind: 'image', mime: imageMime };
  if (extension === 'pdf' || mime === 'application/pdf') return { kind: 'pdf', mime: 'application/pdf' };
  if (extension === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return { kind: 'docx', mime };
  if (['md', 'markdown'].includes(extension) || ['text/markdown', 'text/x-markdown'].includes(mime)) return { kind: 'markdown', mime: 'text/markdown' };
  if (mime.startsWith('text/') || ['txt', 'csv', 'json', 'log', 'xml', 'yaml', 'yml'].includes(extension) || ['application/json', 'application/xml'].includes(mime)) return { kind: 'text', mime: 'text/plain' };
  return null;
}

export function previewLimit(kind: PreviewKind): number {
  return kind === 'text' || kind === 'markdown' ? TEXT_PREVIEW_BYTES : DOCUMENT_PREVIEW_BYTES;
}
