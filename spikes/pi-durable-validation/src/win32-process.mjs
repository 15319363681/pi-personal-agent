import koffi from 'koffi';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('spike_requires_windows_x64');
const k = koffi.load('kernel32.dll');
const u = koffi.load('userenv.dll');
const a = koffi.load('advapi32.dll');
const fn = (lib, signature) => lib.func(signature);
const api = {
  error: fn(k, 'uint32_t __stdcall GetLastError()'),
  createJob: fn(k, 'void * __stdcall CreateJobObjectW(void *, const wchar_t *)'),
  openJob: fn(k, 'void * __stdcall OpenJobObjectW(uint32_t, int, const wchar_t *)'),
  setJob: fn(k, 'int __stdcall SetInformationJobObject(void *, int, void *, uint32_t)'),
  queryJob: fn(k, 'int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)'),
  terminateJob: fn(k, 'int __stdcall TerminateJobObject(void *, uint32_t)'),
  assign: fn(k, 'int __stdcall AssignProcessToJobObject(void *, void *)'),
  close: fn(k, 'int __stdcall CloseHandle(void *)'),
  openProcess: fn(k, 'void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
  resume: fn(k, 'uint32_t __stdcall ResumeThread(void *)'),
  wait: fn(k, 'uint32_t __stdcall WaitForSingleObject(void *, uint32_t)'),
  exit: fn(k, 'int __stdcall GetExitCodeProcess(void *, _Out_ uint32_t *)'),
  inJob: fn(k, 'int __stdcall IsProcessInJob(void *, void *, _Out_ int *)'),
  initAttrs: fn(k, 'int __stdcall InitializeProcThreadAttributeList(void *, uint32_t, uint32_t, _Inout_ size_t *)'),
  updateAttr: fn(k, 'int __stdcall UpdateProcThreadAttribute(void *, uint32_t, uintptr_t, void *, size_t, void *, void *)'),
  deleteAttrs: fn(k, 'void __stdcall DeleteProcThreadAttributeList(void *)'),
  create: fn(k, 'int __stdcall CreateProcessW(const wchar_t *, void *, void *, void *, int, uint32_t, void *, const wchar_t *, void *, void *)'),
  createProfile: fn(u, 'int32_t __stdcall CreateAppContainerProfile(const wchar_t *, const wchar_t *, const wchar_t *, void *, uint32_t, _Out_ void **)'),
  deleteProfile: fn(u, 'int32_t __stdcall DeleteAppContainerProfile(const wchar_t *)'),
  sidString: fn(a, 'int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)'),
  parseSid: fn(a, 'int __stdcall ConvertStringSidToSidW(const wchar_t *, _Out_ void **)'),
  freeSid: fn(a, 'void * __stdcall FreeSid(void *)'),
  free: fn(k, 'void * __stdcall LocalFree(void *)'),
  currentProcess: fn(k,'void * __stdcall GetCurrentProcess()'),
  openToken: fn(a,'int __stdcall OpenProcessToken(void *,uint32_t,_Out_ void **)'),
  tokenInfo: fn(a,'int __stdcall GetTokenInformation(void *,int,void *,uint32_t,_Out_ uint32_t *)'),
  parseSecurity: fn(a,'int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const wchar_t *,uint32_t,_Out_ void **,void *)'),
  getSecurity: fn(a,'uint32_t __stdcall GetSecurityInfo(void *,int,uint32_t,void *,void *,void *,void *,_Out_ void **)'),
  stringifySecurity: fn(a,'int __stdcall ConvertSecurityDescriptorToStringSecurityDescriptorW(void *,uint32_t,uint32_t,_Out_ void **,void *)'),
  handleInfo: fn(k,'int __stdcall GetHandleInformation(void *,_Out_ uint32_t *)'),
};
export function checked(value, operation) { if (!value) throw new Error(`${operation}:win32=${api.error()}`); return value; }
export function closeHandle(handle) { if (handle) checked(api.close(handle), 'CloseHandle'); }
export function currentUserSid(){
 const token=[null];checked(api.openToken(api.currentProcess(),8,token),'OpenProcessToken');
 try{
  const size=[0];api.tokenInfo(token[0],1,null,0,size);const buf=Buffer.alloc(size[0]);checked(api.tokenInfo(token[0],1,buf,buf.length,size),'GetTokenInformation');
  const string=[null];checked(api.sidString(koffi.decode(buf,'void *'),string),'ConvertSidToStringSid');
  try{return koffi.decode(string[0],'char16_t',-1);}finally{api.free(string[0]);}
 }finally{closeHandle(token[0]);}
}
export function privateJobName(identity){return `Local\\PiPersonalAgent.${currentUserSid()}.${createHash('sha256').update(identity).digest('hex')}`;}
export function privateSecurity(){
 const descriptor=[null];checked(api.parseSecurity(`D:P(A;;GA;;;SY)(A;;GA;;;${currentUserSid()})`,1,descriptor,null),'ParseSecurity');
 const attributes=Buffer.alloc(24);attributes.writeUInt32LE(24);koffi.encode(attributes.subarray(8),'void *',descriptor[0]);
 return {attributes,close(){api.free(descriptor[0]);}};
}
export function objectSecurity(handle){
 const descriptor=[null];const code=api.getSecurity(handle,6,4,null,null,null,null,descriptor);if(code!==0)throw Error(`GetSecurityInfo:${code}`);
 const text=[null];const flags=[0];
 try{checked(api.stringifySecurity(descriptor[0],1,4,text,null),'StringifySecurity');checked(api.handleInfo(handle,flags),'GetHandleInformation');return {dacl:koffi.decode(text[0],'char16_t',-1),inheritable:!!(flags[0]&1)};}
 finally{if(text[0])api.free(text[0]);api.free(descriptor[0]);}
}
export function createJob(name) {
  const security=privateSecurity();let handle;
  try{handle=checked(api.createJob(security.attributes, name), 'CreateJobObject');if(api.error()===183){closeHandle(handle);handle=null;throw Error('job_already_owned');}}
  finally{security.close();}
  // x64 JOBOBJECT_EXTENDED_LIMIT_INFORMATION; no inheritable/breakaway handles.
  const info = Buffer.alloc(144); info.writeUInt32LE(0x2000, 16);
  checked(api.setJob(handle, 9, info, info.length), 'SetInformationJobObject');
  return handle;
}
export function jobPids(handle) {
  const info = Buffer.alloc(8192);
  checked(api.queryJob(handle, 3, info, info.length, null), 'QueryInformationJobObject');
  return Array.from({ length: info.readUInt32LE(4) }, (_, i) => Number(info.readBigUInt64LE(8 + i * 8)));
}
export function openJob(name) {
  const h = api.openJob(0x001F003F, 0, name);
  if (!h) { const error = api.error(); if (error === 2) return null; throw new Error(`OpenJobObject:win32=${error}`); }
  return h;
}
export async function cleanupBarrier(name, opener = openJob) {
  const old = opener(name);
  if (!old) return 'not_found';
  try { await terminateJob(old); return 'empty'; } finally { closeHandle(old); }
}
export async function terminateJob(handle) {
  checked(api.terminateJob(handle, 137), 'TerminateJobObject');
  const deadline = Date.now() + 8000;
  while (jobPids(handle).length) { if (Date.now() > deadline) throw new Error('job_cleanup_timeout'); await delay(20); }
}
export function processHandle(pid) { return checked(api.openProcess(0x00100101, 0, pid), 'OpenProcess'); }
export function assignPid(handle, pid) { const p = processHandle(pid); try { checked(api.assign(handle, p), 'AssignProcessToJobObject'); } finally { closeHandle(p); } }
export function isDead(handle) { return api.wait(handle, 0) === 0; }
export function parseSid(string) { const out = [null]; checked(api.parseSid(string, out), 'ConvertStringSidToSid'); return { sid: out[0], close() { api.free(out[0]); } }; }
export function createProfile(name) {
  const sid = [null]; const hr = api.createProfile(name, name, 'Disposable local Pi security probe', null, 0, sid);
  if (hr < 0) throw new Error(`CreateAppContainerProfile:${hr}`);
  const text = [null]; checked(api.sidString(sid[0], text), 'ConvertSidToStringSid');
  const string = koffi.decode(text[0], 'char16_t', -1); api.free(text[0]);
  return { sid: sid[0], string, close() { api.freeSid(sid[0]); const result = api.deleteProfile(name); if (result < 0) throw new Error(`DeleteAppContainerProfile:${result}`); } };
}
export function spawnSuspended(exe, args, { sid, cwd } = {}) {
  const quote = (v) => `"${String(v).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  const command = Buffer.from([exe, ...args].map(quote).join(' ') + '\0', 'utf16le');
  const startup = Buffer.alloc(sid ? 112 : 104); startup.writeUInt32LE(startup.length, 0);
  let attrs, capabilities;
  if (sid) {
    const size = [0]; api.initAttrs(null, 1, 0, size); attrs = koffi.alloc('uint8_t', Number(size[0]));
    checked(api.initAttrs(attrs, 1, 0, size), 'InitializeProcThreadAttributeList');
    capabilities = Buffer.alloc(24); koffi.encode(capabilities, 'void *', sid);
    checked(api.updateAttr(attrs, 0, 0x00020009, capabilities, capabilities.length, null, null), 'UpdateProcThreadAttribute');
    koffi.encode(startup.subarray(104), 'void *', attrs);
  }
  const pi = Buffer.alloc(24);
  try { checked(api.create(exe, command, null, null, 0, 0x08000004 | (sid ? 0x00080000 : 0), null, cwd ?? null, startup, pi), 'CreateProcess'); }
  finally { if (attrs) { api.deleteAttrs(attrs); koffi.free(attrs); } }
  const handle = koffi.decode(pi, 'void *'); const thread = koffi.decode(pi.subarray(8), 'void *');
  const pid = pi.readUInt32LE(16);
  return {
    pid, handle,
    inJob() { const answer = [0]; checked(api.inJob(handle, null, answer), 'IsProcessInJob'); return !!answer[0]; },
    resume() { if (api.resume(thread) === 0xFFFFFFFF) throw new Error(`ResumeThread:${api.error()}`); },
    async wait(timeout = 12000) { const deadline = Date.now() + timeout; while (!isDead(handle)) { if (Date.now() > deadline) throw new Error(`process_timeout:${pid}`); await delay(20); } const code = [0]; checked(api.exit(handle, code), 'GetExitCodeProcess'); return code[0]; },
    close() { closeHandle(thread); closeHandle(handle); },
  };
}
