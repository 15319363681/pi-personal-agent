import koffi from 'koffi';
import { parse, resolve, sep } from 'node:path';

const kernel = koffi.load('kernel32.dll');
const createFile = kernel.func('void * __stdcall CreateFileW(const wchar_t *, uint32_t, uint32_t, void *, uint32_t, uint32_t, void *)');
const closeHandle = kernel.func('int __stdcall CloseHandle(void *)');
const lastError = kernel.func('uint32_t __stdcall GetLastError()');
const getInformation = kernel.func('int __stdcall GetFileInformationByHandle(void *, void *)');
const invalidHandle = (handle) => handle === null || koffi.address(handle) === 0xffffffffffffffffn || koffi.address(handle) === -1n;

// Denying FILE_SHARE_DELETE pins each directory while the leaf is opened.
export function pinWorkspacePath(root, target, { includeTarget = false } = {}) {
  const parent = includeTarget ? resolve(target) : resolve(target, '..');
  const parsed = parse(parent);
  const segments = parent.slice(parsed.root.length).split(sep).filter(Boolean);
  const handles = [];
  let current = parsed.root;
  try {
    for (const segment of segments) {
      current = resolve(current, segment);
      const handle = createFile(current, 0x80000000, 0x3, null, 3, 0x02200000, null);
      if (invalidHandle(handle)) throw Error('workspace_path_unavailable');
      handles.push(handle);
      const information = Buffer.alloc(52);
      if (!getInformation(handle, information)) throw Error('workspace_path_unavailable');
      if (information.readUInt32LE(0) & 0x400) throw Error('workspace_reparse');
    }
  } catch (error) {
    for (const handle of handles.reverse()) closeHandle(handle);
    throw Object.assign(error, { code: error.message, win32: lastError() });
  }
  return () => { for (const handle of handles.reverse()) closeHandle(handle); };
}
