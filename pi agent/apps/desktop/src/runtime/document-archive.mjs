import { crc32, inflateRawSync } from 'node:zlib';

const failure = (code) => Object.assign(new Error(code), { code });

export function inspectDocumentArchive(data, { verifyContents = false } = {}) {
  let end = -1;
  for (let offset = data.length - 22; offset >= Math.max(0, data.length - 65557); offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50 && offset + 22 + data.readUInt16LE(offset + 20) === data.length) { end = offset; break; }
  }
  if (end < 0 || data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6)) throw failure('document_archive_invalid');
  const count = data.readUInt16LE(end + 10);
  const centralSize = data.readUInt32LE(end + 12);
  const centralStart = data.readUInt32LE(end + 16);
  if (!count || count > 2000 || data.readUInt16LE(end + 8) !== count || centralStart + centralSize !== end) throw failure('document_archive_invalid');
  let offset = centralStart;
  let expanded = 0;
  const names = new Set();
  const ranges = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > end || data.readUInt32LE(offset) !== 0x02014b50) throw failure('document_archive_invalid');
    const flags = data.readUInt16LE(offset + 8);
    const method = data.readUInt16LE(offset + 10);
    const checksum = data.readUInt32LE(offset + 16);
    const compressed = data.readUInt32LE(offset + 20);
    const uncompressed = data.readUInt32LE(offset + 24);
    const nameSize = data.readUInt16LE(offset + 28);
    const recordSize = 46 + nameSize + data.readUInt16LE(offset + 30) + data.readUInt16LE(offset + 32);
    const localOffset = data.readUInt32LE(offset + 42);
    expanded += uncompressed;
    if (expanded > 40 * 1024 * 1024 || uncompressed > 10 * 1024 * 1024) throw failure('document_archive_too_large');
    if (flags & 1 || ![0, 8].includes(method) || data.readUInt16LE(offset + 34) || offset + recordSize > end || localOffset + 30 > centralStart || data.readUInt32LE(localOffset) !== 0x04034b50) throw failure('document_archive_invalid');
    const nameBytes = data.subarray(offset + 46, offset + 46 + nameSize);
    const name = nameBytes.toString('utf8');
    if (!name || name.includes('\\') || name.includes('\0') || name.includes(':') || name.startsWith('/') || name.split('/').some((part) => part === '..' || part === '.') || names.has(name)) throw failure('document_archive_invalid');
    names.add(name);
    const localNameSize = data.readUInt16LE(localOffset + 26);
    const localSize = 30 + localNameSize + data.readUInt16LE(localOffset + 28);
    const contentStart = localOffset + localSize;
    const contentEnd = contentStart + compressed;
    if (contentEnd > centralStart || !nameBytes.equals(data.subarray(localOffset + 30, localOffset + 30 + localNameSize)) || data.readUInt16LE(localOffset + 6) !== flags || data.readUInt16LE(localOffset + 8) !== method) throw failure('document_archive_invalid');
    if (!(flags & 8) && (data.readUInt32LE(localOffset + 14) !== checksum || data.readUInt32LE(localOffset + 18) !== compressed || data.readUInt32LE(localOffset + 22) !== uncompressed)) throw failure('document_archive_invalid');
    ranges.push([localOffset, contentEnd]);
    if (verifyContents) {
      const stored = data.subarray(contentStart, contentEnd);
      let content;
      try { content = method === 0 ? stored : inflateRawSync(stored, { maxOutputLength: Math.max(1, uncompressed) }); }
      catch { throw failure('document_archive_invalid'); }
      if (content.length !== uncompressed || crc32(content) !== checksum) throw failure('document_archive_invalid');
    }
    offset += recordSize;
  }
  if (offset !== end) throw failure('document_archive_invalid');
  ranges.sort((left, right) => left[0] - right[0]);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index][0] < ranges[index - 1][1]) throw failure('document_archive_invalid');
  }
}
