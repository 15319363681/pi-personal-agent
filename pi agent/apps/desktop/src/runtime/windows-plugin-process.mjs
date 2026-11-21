import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Windows x64 required');
const kernel = koffi.load('kernel32.dll');
const userenv = koffi.load('userenv.dll');
const security = koffi.load('advapi32.dll');
const api = {
  lastError: kernel.func('uint32_t __stdcall GetLastError()'),
  close: kernel.func('int __stdcall CloseHandle(void *)'),
  createJob: kernel.func('void * __stdcall CreateJobObjectW(void *, const wchar_t *)'),
  setJob: kernel.func('int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)'),
  terminateJob: kernel.func('int __stdcall TerminateJobObject(void *, uint32_t)'),
  queryJob: kernel.func('int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)'),
  assign: kernel.func('int __stdcall AssignProcessToJobObject(void *, void *)'),
  inJob: kernel.func('int __stdcall IsProcessInJob(void *, void *, _Out_ int *)'),
  initAttrs: kernel.func('int __stdcall InitializeProcThreadAttributeList(void *, uint32_t, uint32_t, _Inout_ size_t *)'),
  updateAttr: kernel.func('int __stdcall UpdateProcThreadAttribute(void *, uint32_t, uintptr_t, void *, size_t, void *, void *)'),
  deleteAttrs: kernel.func('void __stdcall DeleteProcThreadAttributeList(void *)'),
  createProcess: kernel.func('int __stdcall CreateProcessW(const wchar_t *, void *, void *, void *, int, uint32_t, void *, const wchar_t *, void *, void *)'),
  resume: kernel.func('uint32_t __stdcall ResumeThread(void *)'),
  wait: kernel.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)'),
  exitCode: kernel.func('int __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)'),
  terminate: kernel.func('int __stdcall TerminateProcess(void *, uint32_t)'),
  createProfile: userenv.func('int32_t __stdcall CreateAppContainerProfile(const wchar_t *, const wchar_t *, const wchar_t *, void *, uint32_t, _Out_ void **)'),
  deleteProfile: userenv.func('int32_t __stdcall DeleteAppContainerProfile(const wchar_t *)'),
  sidString: security.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)'),
  equalSid: security.func('int __stdcall EqualSid(void *, void *)'),
  freeSid: security.func('void * __stdcall FreeSid(void *)'),
  free: kernel.func('void * __stdcall LocalFree(void *)'),
  currentProcess: kernel.func('void * __stdcall GetCurrentProcess()'),
  openToken: security.func('int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)'),
  tokenInfo: security.func('int __stdcall GetTokenInformation(void *, int, void *, uint32_t, _Out_ uint32_t *)')
};
function checked(value, operation) {
  if (!value) throw Error(operation + ':win32=' + api.lastError());
  return value;
}
function close(handle) { if (handle) checked(api.close(handle), 'CloseHandle'); }
function tokenInformation(token, kind) {
  const size = [0];
  api.tokenInfo(token, kind, null, 0, size);
  if (!size[0]) throw Error('GetTokenInformation:win32=' + api.lastError());
  const buffer = Buffer.alloc(size[0]);
  checked(api.tokenInfo(token, kind, buffer, buffer.length, size), 'GetTokenInformation');
  return buffer;
}
function sidText(sid) {
  const text = [null];
  checked(api.sidString(sid, text), 'ConvertSidToStringSid');
  try { return koffi.decode(text[0], 'char16_t', -1); }
  finally { api.free(text[0]); }
}
function signaled(handle, timeout = 0) {
  const status = api.wait(handle, timeout);
  if (status === 0) return true;
  if (status === 258) return false;
  throw Error('WaitForSingleObject:win32=' + api.lastError());
}
function jobEmpty(job) {
  const members = Buffer.alloc(64);
  checked(api.queryJob(job, 3, members, members.length, null), 'QueryInformationJobObject');
  return members.readUInt32LE(4) === 0;
}
export function currentUserSid() {
  const token = [null];
  checked(api.openToken(api.currentProcess(), 8, token), 'OpenProcessToken');
  try { return sidText(koffi.decode(tokenInformation(token[0], 1), 'void *')); }
  finally { close(token[0]); }
}
export function deleteProfile(name) {
  const result = api.deleteProfile(name);
  if (result < 0) throw Error('DeleteAppContainerProfile:' + result);
}
export function createProfile(name) {
  const sid = [null];
  const result = api.createProfile(name, name, 'Pi local plugin Worker', null, 0, sid);
  if (result < 0) throw Error('CreateAppContainerProfile:' + result);
  try {
    const text = sidText(sid[0]);
    let deleted = false;
    return {
      sid: sid[0], text,
      close() {
        if (deleted) return;
        deleteProfile(name);
        api.freeSid(sid[0]);
        deleted = true;
      }
    };
  } catch (cause) {
    api.freeSid(sid[0]);
    deleteProfile(name);
    throw cause;
  }
}

export function createRestrictedProcess({ executable, args, cwd, sid, environment }) {
  let job, processHandle, threadHandle, attributes;
  let assigned = false;
  let attributesInitialized = false;
  let closed = false;
  function releaseHandles() {
    // Attempt every close even if an earlier one fails.
    try { close(threadHandle); }
    finally {
      try { close(processHandle); }
      finally { close(job); closed = true; }
    }
  }
  try {
    job = checked(api.createJob(null, null), 'CreateJobObject');
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2108, 16); // Kill on close, one active process, 512 MiB committed memory.
    limits.writeUInt32LE(1, 40);
    limits.writeBigUInt64LE(512n * 1024n * 1024n, 112);
    checked(api.setJob(job, 9, limits, limits.length), 'SetInformationJobObject');
    const size = [0];
    api.initAttrs(null, 1, 0, size);
    if (!size[0]) throw Error('InitializeProcThreadAttributeList:win32=' + api.lastError());
    attributes = koffi.alloc('uint8_t', Number(size[0]));
    checked(api.initAttrs(attributes, 1, 0, size), 'InitializeProcThreadAttributeList');
    attributesInitialized = true;
    const capabilities = Buffer.alloc(24);
    koffi.encode(capabilities, 'void *', sid);
    checked(api.updateAttr(attributes, 0, 0x00020009, capabilities, capabilities.length, null, null), 'UpdateProcThreadAttribute');
    const startup = Buffer.alloc(112);
    startup.writeUInt32LE(112);
    koffi.encode(startup.subarray(104), 'void *', attributes);
    const quote = (value) => '"' + String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
    if ([executable, cwd, ...args].some((value) => typeof value !== 'string' || value.includes('\0'))) throw Error('Invalid Worker command');
    const entries = Object.entries(environment);
    if (!entries.length || entries.some(([key, value]) => !key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0'))) throw Error('Invalid Worker environment');
    const command = Buffer.from([executable, ...args].map(quote).join(' ') + '\0', 'utf16le');
    const env = Buffer.from(entries.sort(([a], [b]) => a.toUpperCase() < b.toUpperCase() ? -1 : 1).map(([key, value]) => key + '=' + value).join('\0') + '\0\0', 'utf16le');
    const info = Buffer.alloc(24);
    // No inherited handles. Create suspended, assign Job, verify token, then resume.
    checked(api.createProcess(executable, command, null, null, 0, 0x08080404, env, cwd, startup, info), 'CreateProcess');
    processHandle = koffi.decode(info, 'void *');
    threadHandle = koffi.decode(info.subarray(8), 'void *');
    checked(api.assign(job, processHandle), 'AssignProcessToJobObject');
    assigned = true;
    const inJob = [0];
    checked(api.inJob(processHandle, job, inJob), 'IsProcessInJob');
    if (!inJob[0]) throw Error('Worker job identity mismatch');
    const token = [null];
    checked(api.openToken(processHandle, 8, token), 'OpenProcessToken');
    try {
      if (tokenInformation(token[0], 29).readUInt32LE() !== 1) throw Error('Worker is not an AppContainer');
      const identity = tokenInformation(token[0], 31);
      if (!api.equalSid(koffi.decode(identity, 'void *'), sid)) throw Error('Worker AppContainer identity mismatch');
      if (tokenInformation(token[0], 30).readUInt32LE() !== 0) throw Error('Worker has unexpected capabilities');
    } finally { close(token[0]); }
    if (api.resume(threadHandle) === 0xFFFFFFFF) throw Error('ResumeThread:win32=' + api.lastError());
    return {
      pid: info.readUInt32LE(16),
      async wait(timeoutMs) {
        if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw Error('Invalid Worker timeout');
        if (closed) throw Error('Worker process closed');
        const deadline = Date.now() + timeoutMs;
        while (!signaled(processHandle)) {
          if (Date.now() >= deadline) throw Object.assign(Error('plugin_timeout'), { code: 'plugin_timeout' });
          await delay(15);
        }
        const code = [0];
        checked(api.exitCode(processHandle, code), 'GetExitCodeProcess');
        return code[0];
      },
      async close() {
        if (closed) return;
        // Keep handles and profile ownership until the process and Job are empty.
        checked(api.terminateJob(job, 137), 'TerminateJobObject');
        const deadline = Date.now() + 5000;
        while (!signaled(processHandle) || !jobEmpty(job)) {
          if (Date.now() >= deadline) throw Error('Worker cleanup timeout');
          await delay(15);
        }
        releaseHandles();
      }
    };
  } catch (cause) {
    try {
      if (processHandle) {
        if (assigned) checked(api.terminateJob(job, 137), 'TerminateJobObject');
        else if (!signaled(processHandle)) checked(api.terminate(processHandle, 137), 'TerminateProcess');
        // Startup failed before the caller acquired ownership. Reap even an unassigned process.
        if (!signaled(processHandle, 5000)) throw Error('Worker startup cleanup timeout', { cause });
        if (assigned && !jobEmpty(job)) throw Error('Worker startup Job cleanup incomplete', { cause });
      }
    } finally { releaseHandles(); }
    throw cause;
  } finally {
    if (attributes) {
      if (attributesInitialized) api.deleteAttrs(attributes);
      koffi.free(attributes);
    }
  }
}