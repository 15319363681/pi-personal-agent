import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { inspectDocumentArchive } from './document-archive.mjs';

const failure = (code) => Object.assign(new Error(code), { code });
export const DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
export const DOCUMENT_MAX_CHARS = 60000;


export class DocumentReader {
  constructor({ timeoutMs = 10000 } = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw failure('document_request_invalid');
    this.timeoutMs = timeoutMs;
  }

  async read(workspace, path, { startPage = 1, pageCount = 20 } = {}) {
    if (typeof path !== 'string' || !Number.isInteger(startPage) || startPage < 1 || !Number.isInteger(pageCount) || pageCount < 1 || pageCount > 20) throw failure('document_request_invalid');
    const format = extname(path).slice(1).toLowerCase();
    if (!['txt', 'md', 'pdf', 'docx'].includes(format)) throw failure('document_format_unsupported');
    const file = await workspace.read(path, { maxBytes: DOCUMENT_MAX_BYTES });
    if (file.status !== 'ok') throw failure('document_missing');
    const source = { path, format, sha256: createHash('sha256').update(file.data).digest('hex'), size: file.data.length };
    if (format === 'txt' || format === 'md') {
      let text;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(file.data); }
      catch { throw failure('document_not_text'); }
      if (text.includes('\0')) throw failure('document_not_text');
      return { status: text.trim() ? 'ok' : 'no_text', text: text.slice(0, DOCUMENT_MAX_CHARS), truncated: text.length > DOCUMENT_MAX_CHARS, source: { ...source, truncated: text.length > DOCUMENT_MAX_CHARS } };
    }
    if (format === 'docx') inspectDocumentArchive(file.data);
    const worker = new Worker(new URL('./document-parser.mjs', import.meta.url), {
      workerData: { data: file.data, format, startPage, pageCount, maxChars: DOCUMENT_MAX_CHARS },
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      env: {}, stdout: true, stderr: true
    });
    worker.stdout.resume();
    worker.stderr.resume();
    let timer;
    try {
      const parsed = await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(failure('document_timeout')), this.timeoutMs);
        worker.once('message', (result) => result.ok ? resolve(result.result) : reject(failure(['document_page_range', 'document_password_required', 'document_archive_invalid', 'document_archive_too_large'].includes(result.code) ? result.code : 'document_parse_failed')));
        worker.once('error', () => reject(failure('document_parse_failed')));
        worker.once('exit', () => reject(failure('document_parse_failed')));
      });
      return { ...parsed, source: { ...source, truncated: parsed.truncated, ...(parsed.pages ? { pages: parsed.pages } : {}) } };
    } finally { clearTimeout(timer); await worker.terminate(); }
  }
}
