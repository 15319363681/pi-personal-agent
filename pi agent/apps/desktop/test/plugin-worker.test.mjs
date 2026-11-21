import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir, cp, copyFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { join, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import koffi from 'koffi';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { PluginWorker } from '../src/runtime/plugin-worker.mjs';

const require = createRequire(import.meta.url);

test('Windows product Worker executes bounded JSON in an identified AppContainer and Job and cleans every run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-worker-'));
  const worker = new PluginWorker({ dataDir: dir });
  try {
    assert.deepEqual(await worker.run({ source: '(input) => ({ length: input.text.length })', input: { text: 'abc' } }), { length: 3 });
    assert.deepEqual(await worker.run({ source: '() => [typeof process, typeof require, typeof fetch]', input: {} }), ['undefined', 'undefined', 'undefined']);
    assert.deepEqual(await readdir(join(dir, 'plugin-runs')), []);
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('product Worker rejects infinite execution, oversized output and malformed results then remains usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-worker-timeout-'));
  const worker = new PluginWorker({ dataDir: dir, timeoutMs: 1000 });
  try {
    await assert.rejects(worker.run({ source: '() => { while (true) {} }', input: {} }), { code: 'plugin_timeout' });
    await assert.rejects(worker.run({ source: '() => "x".repeat(40000)', input: {} }), { code: 'plugin_output_invalid' });
    await assert.rejects(worker.run({ source: '() => Promise.resolve(2)', input: {} }), { code: 'plugin_output_invalid' });
    assert.equal(await worker.run({ source: '() => 7', input: {} }), 7);
    assert.deepEqual(await readdir(join(dir, 'plugin-runs')), []);
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Electron executable can host the same restricted product Worker', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-worker-electron-'));
  const worker = new PluginWorker({ dataDir: dir, executable: require('electron'), timeoutMs: 5000 });
  try {
    assert.deepEqual(await worker.run({ source: '(input) => ({ answer: input.n + 1 })', input: { n: 8 } }), { answer: 9 });
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('unsupported host or inaccessible executable fails closed without executing plugin source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-worker-deny-'));
  const worker = new PluginWorker({ dataDir: dir, executable: join(dir, 'missing.exe') });
  try {
    await assert.rejects(worker.run({ source: '() => 1', input: {} }), { code: 'plugin_isolation_unavailable' });
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Worker validates actual return values before JSON serialization', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-json-'));
  const worker = new PluginWorker({ dataDir: dir });
  try {
    const invalid = [
      '() => NaN',
      '() => ({ value: undefined })',
      '() => [() => 1]',
      'async () => 2',
      '() => Object.setPrototypeOf((async () => 1)(), null)',
      '() => new Proxy({}, {})',
      '() => ({ result: (async () => 1)() })',
      '() => ({ toJSON() { return 1; } })',
      '() => new Date()',
      '() => Array(2)',
      '() => ({ [Symbol("hidden")]: 1 })',
      '() => ({ get value() { return 1; } })',
      '() => { const a = {}; a.self = a; return a; }',
      '() => { JSON.stringify = () => "7"; return { value: undefined }; }'
    ];
    for (const source of invalid) {
      await t.test(source, async () => {
        await assert.rejects(worker.run({ source, input: {} }), { code: 'plugin_output_invalid' });
      });
    }
    assert.deepEqual(await worker.run({ source: '() => { /* Promise */ return {}; }', input: {} }), {});
    assert.deepEqual(await readdir(join(dir, 'plugin-runs')), []);
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});
test('Electron main and Electron Node hosts both create their default restricted Worker', async (t) => {
  for (const mode of ['electron-main', 'electron-node']) {
    await t.test(mode, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-electron-host-'));
      const resultPath = join(dir, 'result.json');
      try {
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        if (mode === 'electron-node') environment.ELECTRON_RUN_AS_NODE = '1';
        const execution = await promisify(execFile)(require('electron'), [fileURLToPath(new URL('../fixtures/plugin-worker-electron-host.fixture.cjs', import.meta.url)), dir, resultPath], { env: environment, windowsHide: true, timeout: 30000 });
        const result = JSON.parse(await readFile(resultPath, 'utf8'));
        assert.equal(result.ok, true, JSON.stringify({ result, stderr: execution.stderr }));
        assert.equal(result.host, mode);
        assert.deepEqual(result.output, { answer: 9 });
        assert.equal(result.invalid, 'plugin_output_invalid');
        assert.deepEqual(await readdir(join(dir, 'plugin-runs')), []);
      } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    });
  }
});
// Independent Win32 reads verify the live process and Job before ResumeThread.
const winKernel = koffi.load('kernel32.dll');
const winSecurity = koffi.load('advapi32.dll');
const win = {
  open: winKernel.func('void * __stdcall OpenProcess(uint32_t, int, uint32_t)'),
  close: winKernel.func('int __stdcall CloseHandle(void *)'),
  wait: winKernel.func('uint32_t __stdcall WaitForSingleObject(void *, uint32_t)'),
  jobInfo: winKernel.func('int __stdcall QueryInformationJobObject(void *, int, void *, uint32_t, void *)'),
  inJob: winKernel.func('int __stdcall IsProcessInJob(void *, void *, _Out_ int *)'),
  setError: winKernel.func('void __stdcall SetLastError(uint32_t)'),
  openToken: winSecurity.func('int __stdcall OpenProcessToken(void *, uint32_t, _Out_ void **)'),
  tokenInfo: winSecurity.func('int __stdcall GetTokenInformation(void *, int, void *, uint32_t, _Out_ uint32_t *)'),
  sidString: winSecurity.func('int __stdcall ConvertSidToStringSidW(void *, _Out_ void **)'),
  free: winKernel.func('void * __stdcall LocalFree(void *)')
};
function inspectProcess(handle, job) {
  const token = [null];
  assert.equal(win.openToken(handle, 8, token), 1);
  function info(kind) {
    const size = [0];
    win.tokenInfo(token[0], kind, null, 0, size);
    const data = Buffer.alloc(size[0]);
    assert.equal(win.tokenInfo(token[0], kind, data, data.length, size), 1);
    return data;
  }
  function sid(buffer) {
    const pointer = koffi.decode(buffer, 'void *');
    const text = [null];
    assert.equal(win.sidString(pointer, text), 1);
    try { return koffi.decode(text[0], 'char16_t', -1); }
    finally { win.free(text[0]); }
  }
  try {
    const member = [0];
    assert.equal(win.inJob(handle, job, member), 1);
    const limits = Buffer.alloc(144);
    assert.equal(win.jobInfo(job, 9, limits, limits.length, null), 1);
    const members = Buffer.alloc(64);
    assert.equal(win.jobInfo(job, 3, members, members.length, null), 1);
    return {
      appContainer: info(29).readUInt32LE(), sid: sid(info(31)),
      integrity: sid(info(25)), capabilities: info(30).readUInt32LE(), inJob: member[0],
      jobPids: Array.from({ length: members.readUInt32LE(4) }, (_, i) => Number(members.readBigUInt64LE(8 + i * 8))),
      jobFlags: limits.readUInt32LE(16), maxProcesses: limits.readUInt32LE(40), maxMemory: Number(limits.readBigUInt64LE(112))
    };
  } finally { win.close(token[0]); }
}
async function instrumentNative(fault) {
  const record = { events: [], handles: [], flags: null, inheritedHandles: null, identity: null, job: null, environment: null };
  const load = koffi.load;
  koffi.load = function (...args) {
    const library = load(...args);
    return new Proxy(library, {
      get(target, key) {
        if (key !== 'func') return target[key];
        return (...declaration) => {
          const fn = target.func(...declaration);
          const name = /__stdcall (\w+)\(/.exec(declaration[0])[1];
          return (...parameters) => {
            record.events.push(name);
            if (name === fault) { win.setError(5); return name === 'ResumeThread' ? 0xFFFFFFFF : 0; }
            if (name === 'ResumeThread') record.identity = inspectProcess(record.processHandle, record.job);
            const result = fn(...parameters);
            if (name === 'CreateProcessW' && result) {
              record.flags = parameters[5];
              record.inheritedHandles = parameters[4];
              record.environment = parameters[6].toString('utf16le').split('\0').filter(Boolean);
              record.pid = parameters[9].readUInt32LE(16);
              record.processHandle = win.open(0x00101000, 0, record.pid);
              assert.ok(record.processHandle);
              record.handles.push(record.processHandle);
            }
            if (name === 'AssignProcessToJobObject' && result) record.job = parameters[0];
            return result;
          };
        };
      }
    });
  };
  try { return { native: await import('../src/runtime/windows-plugin-process.mjs?audit=' + randomUUID()), record }; }
  finally { koffi.load = load; }
}
async function boundaryFixture(native, executable = process.execPath) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-boundary-'));
  const name = 'Pi.Plugin.Test.' + randomUUID();
  const profile = native.createProfile(name);
  const sandbox = join(dir, 'sandbox');
  const bin = join(sandbox, 'bin');
  const output = join(sandbox, 'output');
  const protectedFile = join(dir, 'protected.txt');
  const outsideNewFile = join(dir, 'outside-new.txt');
  const fixture = join(sandbox, 'trusted-fixture.cjs');
  const acl = (args) => promisify(execFile)(join(process.env.SystemRoot, 'System32/icacls.exe'), args, { windowsHide: true, timeout: 10000 });
  try {
    await acl([dir, '/inheritance:r', '/grant:r', '*' + native.currentUserSid() + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']);
    await mkdir(bin, { recursive: true });
    await mkdir(output);
    await writeFile(protectedFile, 'protected');
    if (basename(executable).toLowerCase().includes('electron')) await cp(dirname(executable), bin, { recursive: true });
    else await copyFile(executable, join(bin, basename(executable)));
    await copyFile(fileURLToPath(new URL('../fixtures/plugin-worker-boundary.fixture.cjs', import.meta.url)), fixture);
    await writeFile(join(sandbox, 'input.json'), '{}');
    await acl([dir, '/grant', '*' + profile.text + ':(RX)']);
    await acl([sandbox, '/grant', '*' + profile.text + ':(RX)']);
    await acl([bin, '/grant', '*' + profile.text + ':(OI)(CI)(RX)', '/T', '/Q']);
    await acl([fixture, '/grant', '*' + profile.text + ':(R)']);
    await acl([join(sandbox, 'input.json'), '/grant', '*' + profile.text + ':(R)']);
    await acl([output, '/grant', '*' + profile.text + ':(OI)(CI)(M)']);
    await acl([output, '/setintegritylevel', '(OI)(CI)L']);
    const environment = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, LOCALAPPDATA: output, TEMP: output, TMP: output, ELECTRON_RUN_AS_NODE: '1' };
    const args = ['--no-addons', '--preserve-symlinks', '--preserve-symlinks-main', '--max-old-space-size=64', fixture, 'space and "quoted" argument\\'];
    if (basename(executable).toLowerCase().includes('electron')) args.unshift('--no-stdio-init');
    return {
      dir, name, profile, output, protectedFile, outsideNewFile,
      options: { executable: join(bin, basename(executable)), args, cwd: sandbox, sid: profile.sid, environment },
      write: (value) => writeFile(join(sandbox, 'input.json'), JSON.stringify({ protectedFile, outsideNewFile, ...value })),
      async close() { profile.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    };
  } catch (cause) { profile.close(); await rm(dir, { recursive: true, force: true }); throw cause; }
}
async function endpoints() {
  const receipts = { tcp: 0, udp: 0, http: 0 };
  const sockets = new Set();
  const tcp = net.createServer((socket) => socket.on('data', (data) => { receipts.tcp++; socket.end(data); }));
  const web = http.createServer((_request, response) => { receipts.http++; response.end('ok'); });
  for (const server of [tcp, web]) server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  async function listen(server) {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return server.address().port;
  }
  const udp = dgram.createSocket('udp4');
  udp.on('message', (data, peer) => { receipts.udp++; udp.send(data, peer.port, peer.address); });
  await new Promise((resolve, reject) => { udp.once('error', reject); udp.bind(0, '127.0.0.1', resolve); });
  return {
    ports: { tcp: await listen(tcp), udp: udp.address().port, http: await listen(web) }, receipts,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([tcp, web, udp].map((server) => new Promise((resolve) => server.close(resolve))));
    }
  };
}

test('live Node and Electron tokens, Job, protected files and local TCP UDP HTTP have successful positive controls', async (t) => {
  for (const executable of [process.execPath, require('electron')]) {
    await t.test(basename(executable), async () => {
      const { native, record } = await instrumentNative();
      const fixture = await boundaryFixture(native, executable);
      const servers = await endpoints();
      let child;
      try {
        await fixture.write({ ports: servers.ports });
        const options = fixture.options;
        await promisify(execFile)(options.executable, options.args, { cwd: options.cwd, env: options.environment, windowsHide: true, timeout: 10000 });
        const control = JSON.parse(await readFile(join(fixture.output, 'boundary.json'), 'utf8'));
        for (const key of ['inside', 'read', 'write', 'create', 'spawn', 'tcp', 'udp', 'http']) assert.equal(control[key], 'allowed', 'positive control ' + key);
        assert.deepEqual(servers.receipts, { tcp: 1, udp: 1, http: 1 });
        const before = { ...servers.receipts };
        await rm(join(fixture.output, 'boundary.json'));
        const previousSecret = process.env.PI_PLUGIN_HOST_SECRET;
        const previousNodeOptions = process.env.NODE_OPTIONS;
        process.env.PI_PLUGIN_HOST_SECRET = 'synthetic-host-secret';
        process.env.NODE_OPTIONS = '--definitely-invalid-host-option';
        try { child = native.createRestrictedProcess(options); }
        finally {
          if (previousSecret === undefined) delete process.env.PI_PLUGIN_HOST_SECRET;
          else process.env.PI_PLUGIN_HOST_SECRET = previousSecret;
          if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
          else process.env.NODE_OPTIONS = previousNodeOptions;
        }
        assert.equal(await child.wait(10000), 0, await readFile(join(fixture.output, 'boundary-error.json'), 'utf8').catch(() => 'trusted boundary fixture failed'));
        const result = JSON.parse(await readFile(join(fixture.output, 'boundary.json'), 'utf8'));
        assert.equal(result.inside, 'allowed');
        for (const key of ['read', 'write', 'create']) assert.match(result[key], /^(EACCES|EPERM)$/i, 'OS denial ' + key + ': ' + result[key]);
        // AppContainer loopback filters can drop traffic. A client deadline alone
        // is insufficient: require zero server receipts between two successful
        // controls using the identical executable, ACLs, ports and environment.
        for (const key of ['tcp', 'http']) assert.match(result[key], /^(EACCES|EPERM|ETIMEDOUT)$/i, 'OS network result ' + key + ': ' + result[key]);
        assert.match(result.udp, /^(EACCES|EPERM|timeout)$/i, 'OS UDP result: ' + result.udp);
        assert.notEqual(result.spawn, 'allowed', 'single-process Job blocks children');
        assert.deepEqual(servers.receipts, before, 'restricted process must produce zero server receipts');
        assert.equal(await readFile(fixture.protectedFile, 'utf8'), 'protected');
        await promisify(execFile)(options.executable, options.args, { cwd: options.cwd, env: options.environment, windowsHide: true, timeout: 10000 });
        const afterControl = JSON.parse(await readFile(join(fixture.output, 'boundary.json'), 'utf8'));
        for (const key of ['tcp', 'udp', 'http']) assert.equal(afterControl[key], 'allowed', 'positive control after isolation ' + key);
        assert.deepEqual(servers.receipts, { tcp: before.tcp + 1, udp: before.udp + 1, http: before.http + 1 });
        assert.deepEqual(result.argv, ['space and "quoted" argument\\']);
        assert.equal(result.environment.PI_PLUGIN_HOST_SECRET, undefined);
        assert.equal(result.environment.NODE_OPTIONS, undefined);
        assert.deepEqual(Object.keys(result.environment).map((key) => key.toUpperCase()).sort(), Object.keys(options.environment).map((key) => key.toUpperCase()).sort());
        assert.equal(record.flags & 4, 4, 'created suspended');
        assert.equal(record.inheritedHandles, 0);
        assert.equal(record.identity.appContainer, 1);
        assert.equal(record.identity.sid, fixture.profile.text);
        assert.equal(record.identity.integrity, 'S-1-16-4096');
        assert.equal(record.identity.capabilities, 0);
        assert.equal(record.identity.inJob, 1);
        assert.deepEqual(record.identity.jobPids, [child.pid]);
        assert.equal(record.identity.jobFlags & 0x2108, 0x2108);
        assert.equal(record.identity.maxProcesses, 1);
        assert.equal(record.identity.maxMemory, 512 * 1024 * 1024);
        assert.ok(record.events.indexOf('AssignProcessToJobObject') < record.events.indexOf('ResumeThread'));
        assert.ok(record.events.indexOf('EqualSid') < record.events.indexOf('ResumeThread'));
        await child.close();
        await child.close();
        child = null;
        assert.equal(win.wait(record.processHandle, 0), 0);
        await fixture.close();
        const recreated = native.createProfile(fixture.name);
        recreated.close();
        assert.equal(await readFile(join(fixture.dir, 'anything')).catch((cause) => cause.code), 'ENOENT');
      } finally {
        await child?.close();
        await servers.close();
        await fixture.close();
        for (const handle of record.handles) win.close(handle);
      }
    });
  }
});

test('suspended startup failures terminate and reap both unassigned and assigned processes before cleanup', async (t) => {
  for (const fault of ['AssignProcessToJobObject', 'IsProcessInJob', 'GetTokenInformation', 'EqualSid', 'ResumeThread']) {
    await t.test(fault, async () => {
      const { native, record } = await instrumentNative(fault);
      // GetTokenInformation is needed while creating the ACL fixture. Use the
      // unmodified module for setup, and the faulted module only for launch.
      const setup = await import('../src/runtime/windows-plugin-process.mjs');
      const fixture = await boundaryFixture(setup);
      try {
        await fixture.write({ hang: true });
        assert.throws(() => native.createRestrictedProcess(fixture.options));
        assert.ok(record.processHandle, 'a real suspended process was created');
        assert.equal(win.wait(record.processHandle, 0), 0, 'failed process has been reaped before returning');
        assert.equal(await readFile(join(fixture.output, 'started.json')).catch((cause) => cause.code), 'ENOENT');
        assert.ok(record.events.includes(fault === 'AssignProcessToJobObject' ? 'TerminateProcess' : 'TerminateJobObject'));
        assert.ok(record.events.includes('WaitForSingleObject'));
        if (fault !== 'ResumeThread') assert.equal(record.events.includes('ResumeThread'), false);
      } finally {
        await fixture.close();
        for (const handle of record.handles) win.close(handle);
      }
    });
  }
});

test('native wall timeout kills a live Worker and the Job before deleting profile and files', async () => {
  const { native, record } = await instrumentNative();
  const fixture = await boundaryFixture(native);
  let child;
  try {
    await fixture.write({ hang: true });
    child = native.createRestrictedProcess(fixture.options);
    await assert.rejects(child.wait(500), { code: 'plugin_timeout' });
    assert.equal(win.wait(record.processHandle, 0), 258, 'trusted hanging fixture is live before close');
    assert.equal(JSON.parse(await readFile(join(fixture.output, 'started.json'), 'utf8')).pid, child.pid);
    await child.close();
    child = null;
    assert.equal(win.wait(record.processHandle, 0), 0);
    await fixture.close();
    const recreated = native.createProfile(fixture.name);
    recreated.close();
  } finally {
    await child?.close();
    await fixture.close();
    for (const handle of record.handles) win.close(handle);
  }
});

test('invalid input JSON and timeout settings cannot disable Worker limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-plugin-worker-input-'));
  const worker = new PluginWorker({ dataDir: dir });
  try {
    for (const timeoutMs of [NaN, Infinity, 0, -1, 1.5, 60001]) assert.throws(() => new PluginWorker({ dataDir: dir, timeoutMs }), { code: 'plugin_request_invalid' });
    for (const input of [NaN, undefined, { f() {} }, [undefined], Array(2), { [Symbol('hidden')]: 1 }, { get secret() { throw Error('getter must not run'); } }]) {
      await assert.rejects(worker.run({ source: '(input) => input', input }), { code: 'plugin_arguments_invalid' });
    }
    assert.deepEqual(await readdir(dir), []);
  } finally { await worker.close(); await rm(dir, { recursive: true, force: true }); }
});