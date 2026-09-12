import { describe, expect, it } from 'vitest';
import { previewFormat, previewLimit, TEXT_PREVIEW_BYTES, DOCUMENT_PREVIEW_BYTES } from '../src/preview-format';

describe('file preview formats', () => {
  it.each([
    ['photo.PNG', 'application/octet-stream', 'image'],
    ['image', 'image/webp', 'image'],
    ['meeting.PDF', 'application/octet-stream', 'pdf'],
    ['document', 'application/pdf', 'pdf'],
    ['notes.md', 'text/plain', 'markdown'],
    ['notes', 'text/markdown; charset=utf-8', 'markdown'],
    ['minutes.docx', '', 'docx'],
    ['notes.txt', '', 'text'],
    ['data.json', 'application/json', 'text'],
    ['page.html', 'text/html', 'text'],
  ])('recognizes %s with MIME %s', (name, mime, kind) => {
    expect(previewFormat({ name, mime })?.kind).toBe(kind);
  });

  it('leaves unsupported binary formats downloadable without trying to interpret them', () => {
    for (const name of ['archive.zip', 'legacy.doc', 'slides.pptx', 'program.exe']) {
      expect(previewFormat({ name, mime: 'application/octet-stream' })).toBeNull();
    }
  });

  it('bounds text parsing independently of image and document previews', () => {
    expect(previewLimit('markdown')).toBe(TEXT_PREVIEW_BYTES);
    expect(previewLimit('text')).toBe(TEXT_PREVIEW_BYTES);
    expect(previewLimit('pdf')).toBe(DOCUMENT_PREVIEW_BYTES);
    expect(previewLimit('docx')).toBe(DOCUMENT_PREVIEW_BYTES);
  });
});
