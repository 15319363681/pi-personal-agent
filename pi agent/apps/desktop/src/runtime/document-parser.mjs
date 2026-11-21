import { parentPort, workerData } from 'node:worker_threads';
import { inspectDocumentArchive } from './document-archive.mjs';

const { data, format, startPage, pageCount, maxChars } = workerData;

async function parsePdf() {
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = getDocument({
    data: Uint8Array.from(data), isEvalSupported: false, useSystemFonts: false,
    disableFontFace: true, useWasm: false, disableAutoFetch: true,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false, verbosity: 0
  });
  try {
    const pdf = await task.promise;
    if (startPage > pdf.numPages) throw Object.assign(Error('document_page_range'), { code: 'document_page_range' });
    const chunks = [], pages = [];
    let length = 0, truncated = startPage !== 1 || startPage + pageCount - 1 < pdf.numPages;
    for (let number = startPage; number <= Math.min(pdf.numPages, startPage + pageCount - 1); number++) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
      const chunk = '[第 ' + number + ' 页]\n' + text;
      pages.push(number);
      const available = maxChars - length - (chunks.length ? 2 : 0);
      chunks.push(chunk.slice(0, Math.max(0, available)));
      length += Math.min(chunk.length, Math.max(0, available)) + (chunks.length > 1 ? 2 : 0);
      page.cleanup();
      if (chunk.length > available || length >= maxChars) { truncated = true; break; }
    }
    const text = chunks.join('\n\n');
    const hasText = text.replace(/\[第 \d+ 页\]/g, '').trim().length > 0;
    return { status: hasText ? 'ok' : 'no_text', text, pages, totalPages: pdf.numPages, truncated };
  } finally { await task.destroy(); }
}

try {
  let result;
  if (format === 'pdf') result = await parsePdf();
  else {
    inspectDocumentArchive(Buffer.from(data), { verifyContents: true });
    const { default: mammoth } = await import('mammoth');
    const parsed = await mammoth.extractRawText({ buffer: Buffer.from(data) }, { externalFileAccess: false });
    result = { status: parsed.value.trim() ? 'ok' : 'no_text', text: parsed.value.slice(0, maxChars), truncated: parsed.value.length > maxChars };
  }
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({ ok: false, code: error.name === 'PasswordException' ? 'document_password_required' : error.code ?? 'document_parse_failed' });
}
