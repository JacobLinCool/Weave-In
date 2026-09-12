import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSharedFile, SHARED_FILE_TEXT_LENGTH } from '../src/agents/attachments';
import type { MeetingToolsContext, ToolResult } from '../src/webmcp';

const pdf = vi.hoisted(() => ({ getDocument: vi.fn(), getPage: vi.fn(), getTextContent: vi.fn(), render: vi.fn(), destroy: vi.fn() }));
vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: {}, getDocument: pdf.getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/pdf.worker.mjs' }));
// Workers resolve Mammoth's Node entry; select its real browser build, as the production client does.
vi.mock('mammoth', async () => ({ default: await vi.importActual<typeof import('mammoth')>('mammoth/mammoth.browser') }));

function fixture(name = 'notes.md', content: BlobPart = '# Shared meeting notes\nDiscuss the workflow.', mime = 'text/markdown') {
  const blob = new Blob([content], { type: mime });
  const file = { id: 'f1', name, mime, size: blob.size, sharedBy: { name: 'Guest', peerId: 'guest' } };
  const download = vi.fn(async () => ({ file, blob }));
  const context = { snapshot: () => ({ files: [file] }), download } as unknown as MeetingToolsContext;
  return { file, blob, context, download };
}

function body(result: ToolResult): Record<string, unknown> {
  const content = result.content[0]!;
  expect(content.type).toBe('text');
  return JSON.parse(content.type === 'text' ? content.text : '{}') as Record<string, unknown>;
}

function canvasMocks() {
  const drawImage = vi.fn();
  const close = vi.fn();
  const render = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 3200, height: 2000, close })));
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0,
    getContext: () => ({ drawImage, fillRect: vi.fn(), fillStyle: '' }),
    toBlob: (callback: (blob: Blob) => void) => { render(); callback(new Blob([new Uint8Array([255, 216, 255, 217])], { type: 'image/jpeg' })); },
  }) });
  return { drawImage, close, render };
}

beforeEach(() => {
  pdf.getTextContent.mockResolvedValue({ items: [{ str: 'Page one', hasEOL: true }, { str: 'Workflow', hasEOL: false }] });
  pdf.render.mockReturnValue({ promise: Promise.resolve() });
  pdf.getPage.mockResolvedValue({ getTextContent: pdf.getTextContent, getViewport: ({ scale }: { scale: number }) => ({ width: 1000 * scale, height: 1400 * scale }), render: pdf.render });
  pdf.destroy.mockResolvedValue(undefined);
  pdf.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: pdf.getPage }), destroy: pdf.destroy });
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('model-readable shared meeting attachments', () => {
  it('fetches a participant file and pages actual Markdown without breaking Unicode', async () => {
    const { context, download } = fixture('notes.md', 'ab🙂c\n會議');
    const first = await readSharedFile(context, { fileId: 'f1', length: 3 }, () => true);
    expect(body(first)).toMatchObject({ text: 'ab', nextOffset: 2, eof: false, totalCharacters: 8, sharedBy: { peerId: 'guest' } });
    const second = await readSharedFile(context, { fileId: 'f1', offset: 2, length: 3 }, () => true);
    expect(body(second)).toMatchObject({ text: '🙂c', nextOffset: 5, eof: false });
    const third = await readSharedFile(context, { fileId: 'f1', offset: 5 }, () => true);
    expect(body(third)).toMatchObject({ text: '\n會議', nextOffset: null, eof: true });
    expect(download).toHaveBeenCalledWith('f1');
    expect((await readSharedFile(context, { fileId: 'f1', offset: 3 }, () => true)).isError).toBe(true);
  });

  it('bounds output length and distinguishes declared size from actual downloaded bytes', async () => {
    const { context, file, download } = fixture('long.txt', 'x'.repeat(SHARED_FILE_TEXT_LENGTH + 20));
    expect(body(await readSharedFile(context, { fileId: 'f1', length: SHARED_FILE_TEXT_LENGTH }, () => true))).toMatchObject({ nextOffset: SHARED_FILE_TEXT_LENGTH, eof: false, truncated: true });
    expect((await readSharedFile(context, { fileId: 'f1', length: SHARED_FILE_TEXT_LENGTH + 1 }, () => true)).isError).toBe(true);
    file.size = 1024 * 1024 + 1;
    download.mockClear();
    expect((await readSharedFile(context, { fileId: 'f1' }, () => true)).isError).toBe(true);
    expect(download).not.toHaveBeenCalled();
    file.size = 1;
    expect((await readSharedFile(context, { fileId: 'f1' }, () => true)).content).toEqual([{ type: 'text', text: 'The downloaded file size does not match the shared file metadata.' }]);
    download.mockResolvedValueOnce({ file, blob: new Blob(['x'.repeat(1024 * 1024 + 1)]) });
    expect((await readSharedFile(context, { fileId: 'f1' }, () => true)).isError).toBe(true);
  });

  it('keeps default CJK pages within 6000 UTF-8 bytes and resumes without skipping text', async () => {
    const text = '會議流程圖'.repeat(900);
    const { context } = fixture('會議.md', text);
    const first = body(await readSharedFile(context, { fileId: 'f1' }, () => true));
    expect(first).toMatchObject({ nextOffset: 2000, eof: false });
    expect(new TextEncoder().encode(String(first.text)).byteLength).toBe(6000);
    const second = body(await readSharedFile(context, { fileId: 'f1', offset: first.nextOffset }, () => true));
    const last = body(await readSharedFile(context, { fileId: 'f1', offset: second.nextOffset }, () => true));
    expect(String(first.text) + String(second.text) + String(last.text)).toBe(text);
    expect(last).toMatchObject({ nextOffset: null, eof: true });
  });

  it('rejects missing/out-of-scope ids and unsupported types before requesting P2P bytes', async () => {
    const { context, download } = fixture('archive.zip', 'binary', 'application/zip');
    for (const input of [null, {}, { fileId: 'other' }, { fileId: 'f1' }, { fileId: 'f1', offset: -1 }]) {
      expect((await readSharedFile(context, input, () => true)).isError).toBe(true);
    }
    expect(download).not.toHaveBeenCalled();
  });

  it('does not turn invalid UTF-8 or binary payloads into purported readable text', async () => {
    const invalid = fixture('notes.txt', new Uint8Array([0xff, 0xfe]));
    expect((await readSharedFile(invalid.context, { fileId: 'f1' }, () => true)).isError).toBe(true);
    const binary = fixture('notes.txt', 'hello\0payload');
    expect((await readSharedFile(binary.context, { fileId: 'f1' }, () => true)).isError).toBe(true);
  });

  it('returns images in native image blocks at bounded dimensions and releases bitmap memory', async () => {
    const mocks = canvasMocks();
    const { context } = fixture('diagram.png', new Uint8Array([137, 80, 78, 71]), 'image/png');
    const result = await readSharedFile(context, { fileId: 'f1' }, () => true);
    expect(body(result)).toMatchObject({ sourceWidth: 3200, sourceHeight: 2000, width: 1600, height: 1000, eof: true });
    expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '/9j/2Q==' });
    expect(JSON.stringify(body(result))).not.toContain('/9j/2Q==');
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('reads selected PDF text with truthful page counts and independent text/page continuation', async () => {
    const { context } = fixture('slides.pdf', '%PDF', 'application/pdf');
    const first = body(await readSharedFile(context, { fileId: 'f1', length: 5 }, () => true));
    expect(first).toMatchObject({ text: 'Page ', page: 1, pageCount: 2, nextOffset: 5, pageEof: false, nextPage: null, eof: false });
    const rest = body(await readSharedFile(context, { fileId: 'f1', offset: 5 }, () => true));
    expect(rest).toMatchObject({ text: 'one\nWorkflow ', nextOffset: null, pageEof: true, nextPage: 2, eof: false });
    expect(body(await readSharedFile(context, { fileId: 'f1', page: 2 }, () => true))).toMatchObject({ pageCount: 2, nextPage: null, eof: true });
    expect((await readSharedFile(context, { fileId: 'f1', page: 3 }, () => true)).isError).toBe(true);
    expect(pdf.render).not.toHaveBeenCalled();
    expect(pdf.destroy).toHaveBeenCalledTimes(4);
  });

  it('renders scanned PDF pages and permits explicit image inspection of text pages', async () => {
    canvasMocks();
    const { context } = fixture('scanned.pdf', '%PDF', 'application/pdf');
    pdf.getTextContent.mockResolvedValueOnce({ items: [] });
    const scanned = await readSharedFile(context, { fileId: 'f1' }, () => true);
    expect(body(scanned)).toMatchObject({ text: '', pageCount: 2, nextPage: 2, image: { width: 1143, height: 1600 } });
    expect(body(scanned).extraction).toContain('OCR has not been performed');
    expect(scanned.content[1]?.type).toBe('image');
    const illustrated = await readSharedFile(context, { fileId: 'f1', render: true }, () => true);
    expect(body(illustrated).text).toBe('Page one\nWorkflow ');
    expect(illustrated.content[1]?.type).toBe('image');
  });

  it('surfaces password-protected or damaged PDFs and destroys the loading task', async () => {
    const { context } = fixture('locked.pdf', '%PDF', 'application/pdf');
    pdf.getDocument.mockImplementationOnce(() => ({ promise: Promise.reject(new Error('This PDF requires a password.')), destroy: pdf.destroy }));
    const result = await readSharedFile(context, { fileId: 'f1' }, () => true);
    expect(result).toMatchObject({ isError: true, content: [{ text: 'This PDF requires a password.' }] });
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });

  it('extracts and pages actual DOCX XML text without inventing a physical page count', async () => {
    const { context } = fixture('notes.docx', docx('A workflow &amp; meeting decision'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const first = await readSharedFile(context, { fileId: 'f1', length: 10 }, () => true);
    expect(first.isError, JSON.stringify(first)).not.toBe(true);
    expect(body(first)).toMatchObject({ text: 'A workflow', nextOffset: 10, pageCount: null, eof: false });
    const rest = body(await readSharedFile(context, { fileId: 'f1', offset: 10 }, () => true));
    expect(rest.text).toContain(' & meeting decision');
    expect(rest.eof).toBe(true);
  });

  it('rejects malformed DOCX archives and excessive declared expansion before parsing', async () => {
    const malformed = fixture('notes.docx', 'invalid zip');
    expect((await readSharedFile(malformed.context, { fileId: 'f1' }, () => true)).isError).toBe(true);
    const archive = docx('hello');
    const view = new DataView(archive.buffer);
    for (let i = 0; i + 46 < archive.length; i++) {
      if (view.getUint32(i, true) === 0x02014b50) { view.setUint32(i + 24, 60 * 1024 * 1024, true); break; }
    }
    const expanded = fixture('notes.docx', archive);
    expect((await readSharedFile(expanded.context, { fileId: 'f1' }, () => true)).content).toEqual([{ type: 'text', text: 'This DOCX expands beyond the 50 MiB reading limit.' }]);
  });

  it('fences inactive turns before download and after delayed P2P or parser completion', async () => {
    const { context, download, file, blob } = fixture();
    expect((await readSharedFile(context, { fileId: 'f1' }, () => false)).isError).toBe(true);
    expect(download).not.toHaveBeenCalled();
    let active = true;
    download.mockImplementationOnce(async () => { active = false; return { file, blob }; });
    expect(await readSharedFile(context, { fileId: 'f1' }, () => active)).toEqual({ isError: true, content: [{ type: 'text', text: 'This agent turn has ended.' }] });
    active = true;
    const document = fixture('notes.pdf', '%PDF', 'application/pdf');
    pdf.getTextContent.mockImplementationOnce(async () => { active = false; return { items: [{ str: 'secret' }] }; });
    const result = await readSharedFile(document.context, { fileId: 'f1' }, () => active);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.isError).toBe(true);
    expect(pdf.destroy).toHaveBeenCalledOnce();
  });
});

/** Small valid stored ZIP fixture, exercising Mammoth's real document extraction. */
function docx(text: string): Uint8Array<ArrayBuffer> {
  const files = {
    '[Content_Types].xml': '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
  };
  const locals: Uint8Array<ArrayBuffer>[] = []; const directories: Uint8Array<ArrayBuffer>[] = [];
  let position = 0;
  for (const [path, text] of Object.entries(files)) {
    const name = new TextEncoder().encode(path); const data = new TextEncoder().encode(text);
    let crc = 0xffffffff;
    for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = new Uint8Array(30 + name.length + data.length); const header = new DataView(local.buffer);
    header.setUint32(0, 0x04034b50, true); header.setUint16(4, 20, true); header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true); header.setUint32(22, data.length, true); header.setUint16(26, name.length, true);
    local.set(name, 30); local.set(data, 30 + name.length);
    const directory = new Uint8Array(46 + name.length); const central = new DataView(directory.buffer);
    central.setUint32(0, 0x02014b50, true); central.setUint16(4, 20, true); central.setUint16(6, 20, true);
    central.setUint32(16, crc, true); central.setUint32(20, data.length, true); central.setUint32(24, data.length, true);
    central.setUint16(28, name.length, true); central.setUint32(42, position, true); directory.set(name, 46);
    locals.push(local); directories.push(directory); position += local.length;
  }
  const centralSize = directories.reduce((size, directory) => size + directory.length, 0);
  const end = new Uint8Array(22); const view = new DataView(end.buffer);
  view.setUint32(0, 0x06054b50, true); view.setUint16(8, directories.length, true); view.setUint16(10, directories.length, true);
  view.setUint32(12, centralSize, true); view.setUint32(16, position, true);
  const output = new Uint8Array(position + centralSize + end.length); let cursor = 0;
  for (const bytes of [...locals, ...directories, end]) { output.set(bytes, cursor); cursor += bytes.length; }
  return output;
}
