import koffi from 'koffi';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { privateSecurity,currentUserSid } from './win32-process.mjs';

const WAIT_OBJECT_0 = 0;
const WAIT_ABANDONED = 0x80;
const WAIT_TIMEOUT = 0x102;

export function acquireWriter(databasePath, timeoutMs = 0xFFFFFFFF) {
  if (process.platform !== 'win32') throw new Error('windows_writer_lock_requires_windows');
  const kernel = koffi.load('kernel32.dll');
  const createMutex = kernel.func('void * __stdcall CreateMutexW(void * attributes, int initialOwner, const wchar_t * name)');
  const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(void * handle, uint32_t milliseconds)');
  const release = kernel.func('int __stdcall ReleaseMutex(void * handle)');
  const close = kernel.func('int __stdcall CloseHandle(void * handle)');
  const absolute=resolve(databasePath);
  const normalized = (existsSync(absolute)?realpathSync.native(absolute):resolve(realpathSync.native(dirname(absolute)),basename(absolute))).toLowerCase();
  const hash = createHash('sha256').update(normalized).digest('hex');
  const security=privateSecurity();let handle;
  try{handle=createMutex(security.attributes,0,`Local\\PiPersonalAgent.Writer.${currentUserSid()}.${hash}`);}finally{security.close();}
  if (!handle) throw new Error('writer_mutex_create_failed');
  const result = wait(handle, timeoutMs);
  if (result === WAIT_TIMEOUT) { close(handle); throw new Error('writer_busy'); }
  if (result !== WAIT_OBJECT_0 && result !== WAIT_ABANDONED) { close(handle); throw new Error(`writer_mutex_wait_failed:${result}`); }
  let released = false;
  return {
    abandoned: result === WAIT_ABANDONED,
    release() {
      if (released) return;
      released = true;
      if (!release(handle)) throw new Error('writer_mutex_release_failed');
      if (!close(handle)) throw new Error('writer_mutex_close_failed');
      kernel.unload();
    },
  };
}
