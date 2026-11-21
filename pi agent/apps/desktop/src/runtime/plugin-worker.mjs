import { mkdir, mkdtemp, cp, copyFile, writeFile, readFile, lstat, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify, types } from 'node:util';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { boundedPluginJson } from './plugins.mjs';

const exec = promisify(execFile);
// Electron virtualizes .asar paths. Copy runtime files through its physical-disk API.
const { cp: copyRuntime, rm: removeRun } = process.versions.electron ? createRequire(import.meta.url)('original-fs').promises : { cp, rm };
const failure = (code, cause) => Object.assign(new Error(code), { code, cause });

function pluginInput(value) {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 12) throw failure('plugin_arguments_invalid');
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object' || types.isProxy(item) || types.isPromise(item)) throw failure('plugin_arguments_invalid');
    const array = Array.isArray(item);
    if (!array && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw failure('plugin_arguments_invalid');
    const properties = Object.getOwnPropertyDescriptors(item);
    const keys = Reflect.ownKeys(properties);
    if (array && (item.length > 4096 || keys.length !== item.length + 1)) throw failure('plugin_arguments_invalid');
    for (const key of keys) {
      if (array && key === 'length') continue;
      const property = properties[key];
      if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || !property.enumerable || !Object.hasOwn(property, 'value')) throw failure('plugin_arguments_invalid');
      if (array && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= item.length)) throw failure('plugin_arguments_invalid');
      visit(property.value, depth + 1);
    }
  }
  visit(value, 0);
  return boundedPluginJson(value);
}

export class PluginWorker {
  constructor({ dataDir, executable = process.execPath, timeoutMs = 3000 }) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 60000) throw failure('plugin_request_invalid');
    this.dataDir = dataDir;
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.tail = Promise.resolve();
    this.closed = false;
  }

  run(request) {
    if (this.closed) return Promise.reject(failure('plugin_closed'));
    const next = this.tail.then(() => this.execute(request));
    this.tail = next.catch(() => {});
    return next;
  }

  async execute(request) {
    if (process.platform !== 'win32' || process.arch !== 'x64') throw failure('plugin_isolation_unavailable');
    if (!request || typeof request.source !== 'string' || !request.source.trim() || Buffer.byteLength(request.source) > 32768) throw failure('plugin_definition_invalid');
    const { source } = request;
    const input = pluginInput(request.input);
    const native = await import('./windows-plugin-process.mjs').catch((cause) => { throw failure('plugin_isolation_unavailable', cause); });
    const runs = join(this.dataDir, 'plugin-runs');
    await mkdir(runs, { recursive: true });
    const directory = await mkdtemp(join(runs, 'run-'));
    let profile, child;
    let result, failed;
    const profileName = 'Pi.Plugin.' + randomUUID();
    try {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot) throw failure('plugin_isolation_unavailable');
      const bin = join(directory, 'bin');
      const output = join(directory, 'output');
      // AppContainer creation requires LOCALAPPDATA. Use the disposable output
      // directory and an explicit whitelist without NODE_OPTIONS or host credentials.
      const environment = { SystemRoot: systemRoot, WINDIR: systemRoot, LOCALAPPDATA: output, TEMP: output, TMP: output, ELECTRON_RUN_AS_NODE: '1' };
      const acl = (args) => exec(join(systemRoot, 'System32', 'icacls.exe'), args, { windowsHide: true, timeout: 10000, env: environment });
      const user = native.currentUserSid();
      await acl([directory, '/inheritance:r', '/grant:r', '*' + user + ':(OI)(CI)F', '*S-1-5-18:(OI)(CI)F']);
      await mkdir(bin);
      await mkdir(output);
      const electron = Boolean(process.versions.electron && this.executable === process.execPath) || basename(this.executable).toLowerCase().includes('electron');
      if (electron) await copyRuntime(dirname(this.executable), bin, { recursive: true });
      else await copyFile(this.executable, join(bin, basename(this.executable)));
      const bootstrap = join(directory, 'bootstrap.cjs');
      await copyFile(fileURLToPath(new URL('./plugin-bootstrap.cjs', import.meta.url)), bootstrap);
      await writeFile(join(directory, 'input.json'), JSON.stringify({ source, input, executionMs: Math.max(25, this.timeoutMs - 250) }));
      profile = native.createProfile(profileName);
      await acl([directory, '/grant', '*' + profile.text + ':(RX)']);
      await acl([bin, '/grant', '*' + profile.text + ':(OI)(CI)(RX)', '/T', '/Q']);
      await acl([bootstrap, '/grant', '*' + profile.text + ':(R)']);
      await acl([join(directory, 'input.json'), '/grant', '*' + profile.text + ':(R)']);
      await acl([output, '/grant', '*' + profile.text + ':(OI)(CI)(M)']);
      await acl([output, '/setintegritylevel', '(OI)(CI)L']);
      // Avoid realpath traversal of protected ancestors and Electron's NUL-device
      // initialization. The Worker uses only its granted files and no stdio handles.
      const args = ['--no-addons', '--preserve-symlinks', '--preserve-symlinks-main', '--max-old-space-size=64', bootstrap];
      if (electron) args.unshift('--no-stdio-init');
      child = native.createRestrictedProcess({ executable: join(bin, basename(this.executable)), args, sid: profile.sid, cwd: directory, environment });
      const exitCode = await child.wait(this.timeoutMs);
      await child.close();
      child = null;
      if (exitCode !== 0) throw failure('plugin_execution_failed', Object.assign(new Error('Worker process exited'), { exitCode }));
      const resultPath = join(output, 'result.json');
      const info = await lstat(resultPath);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 35000) throw failure('plugin_output_invalid');
      let response;
      try { response = JSON.parse(await readFile(resultPath, 'utf8')); }
      catch (cause) { throw failure('plugin_output_invalid', cause); }
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw failure('plugin_output_invalid');
      if (response.ok !== true) throw failure(['plugin_timeout', 'plugin_output_invalid', 'plugin_execution_failed'].includes(response.code) ? response.code : 'plugin_execution_failed');
      result = boundedPluginJson(response.output, 'plugin_output_invalid');
    } catch (cause) {
      failed = cause.code?.startsWith('plugin_') ? cause : failure('plugin_isolation_unavailable', cause);
    } finally {
      try { await child?.close(); child = null; }
      catch (cause) { failed = failure('plugin_cleanup_failed', cause); }
      // Keep the profile and files if termination could not be confirmed.
      if (!child) {
        try { profile?.close(); }
        catch (cause) { failed = failure('plugin_cleanup_failed', cause); }
        try { await removeRun(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
        catch (cause) { failed = failure('plugin_cleanup_failed', cause); }
      }
    }
    if (failed) throw failed;
    return result;
  }

  async close() { this.closed = true; await this.tail; }
}