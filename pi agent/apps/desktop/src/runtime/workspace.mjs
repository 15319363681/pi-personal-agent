import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

const DEFAULT_MAX_READ_BYTES = 256 * 1024;
const DEFAULT_MAX_ENTRIES = 200;
const workspaceIdentityContext = new AsyncLocalStorage();

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(resolve(left)) === normalize(resolve(right));
}


export async function workspaceIdentity(root) {
  let stats;
  let canonical;
  try {
    stats = await lstat(root, { bigint: true });
    canonical = await realpath(root);
  } catch {
    throw Error('workspace_root_changed');
  }
  if (stats.isSymbolicLink() || !samePath(canonical, root)) throw Error('workspace_reparse');
  if (!stats.isDirectory()) throw Error('workspace_root_changed');
  return { root: canonical, dev: String(stats.dev), ino: String(stats.ino), birthtimeNs: String(stats.birthtimeNs) };
}

export async function assertWorkspaceIdentity(expected) {
  if (!expected || typeof expected.root !== 'string' || typeof expected.dev !== 'string' ||
      typeof expected.ino !== 'string' || typeof expected.birthtimeNs !== 'string') {
    throw Error('workspace_root_changed');
  }
  const actual = await workspaceIdentity(expected.root);
  if (!samePath(actual.root, expected.root) || actual.dev !== expected.dev ||
      actual.ino !== expected.ino || actual.birthtimeNs !== expected.birthtimeNs) {
    throw Error('workspace_root_changed');
  }
}

export function withWorkspaceIdentity(identity, operation) {
  return workspaceIdentityContext.run(identity, operation);
}

export class WorkspaceAdmission {
  constructor(root, mode = 'read-only', options = {}) {
    this.root = root;
    this.mode = mode;
    this.identity = options.identity;
    this.maxReadBytes = options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  static async open(root, mode = 'read-only', options = {}) {
    const expected = workspaceIdentityContext.getStore();
    const identity = await workspaceIdentity(root);
    if (expected) {
      if (!samePath(identity.root, expected.root)) throw Error('workspace_root_changed');
      await assertWorkspaceIdentity(expected);
      if (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.birthtimeNs !== expected.birthtimeNs) {
        throw Error('workspace_root_changed');
      }
    }
    return new WorkspaceAdmission(identity.root, mode, { ...options, identity: expected ?? identity });
  }

  #path(input) {
    if (typeof input !== 'string') throw Error('workspace_invalid_path');
    if (isAbsolute(input)) throw Error('workspace_absolute_path');
    if (/[\x00-\x1f:]/.test(input)) throw Error('workspace_invalid_path');
    const segments = input.split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => segment === '..')) throw Error('workspace_escape');
    if (segments.some((segment) => /[. ]$/.test(segment) && segment !== '.' || /[<>"|?*]/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw Error('workspace_invalid_path');
    const target = resolve(this.root, input || '.');
    const rel = relative(this.root, target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw Error('workspace_escape');
    return target;
  }

  async #inspect(target, { allowMissingLeaf = false } = {}) {
    await assertWorkspaceIdentity(this.identity);
    const rel = relative(this.root, target);
    const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    let current = this.root;
    for (let index = 0; index < segments.length; index += 1) {
      current = join(current, segments[index]);
      let stats;
      try {
        stats = await lstat(current);
      } catch (error) {
        if (error.code === 'ENOENT' && (allowMissingLeaf || index === segments.length - 1)) return { missing: true };
        throw error;
      }
      if (stats.isSymbolicLink()) throw Error('workspace_reparse');
      const canonical = await realpath(current);
      if (!samePath(canonical, current)) throw Error('workspace_reparse');
      if (index < segments.length - 1 && !stats.isDirectory()) throw Error('workspace_not_directory');
    }
    return { missing: false, stats: await lstat(target) };
  }

  async #assertExistingAncestors(target) {
    await assertWorkspaceIdentity(this.identity);
    const rel = relative(this.root, target);
    const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    let current = this.root;
    for (const segment of segments) {
      current = join(current, segment);
      try {
        const stats = await lstat(current);
        if (stats.isSymbolicLink()) throw Error('workspace_reparse');
        const canonical = await realpath(current);
        if (!samePath(canonical, current)) throw Error('workspace_reparse');
      } catch (error) {
        if (error.code === 'ENOENT') break;
        throw error;
      }
    }
  }

  async #pin(target, options) {
    if (process.platform !== 'win32') return () => {};
    const { pinWorkspacePath } = await import('./windows-workspace.mjs');
    return pinWorkspacePath(this.root, target, options);
  }

  async read(path, { maxBytes = this.maxReadBytes } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 20 * 1024 * 1024) throw Error('workspace_read_limit_invalid');
    const target = this.#path(path);
    await assertWorkspaceIdentity(this.identity);
    const release = await this.#pin(target);
    let handle;
    try {
      const inspected = await this.#inspect(target);
      if (inspected.missing) return { status: 'missing' };
      if (!inspected.stats.isFile()) throw Error('workspace_not_file');
      if (inspected.stats.size > maxBytes) throw Error('workspace_file_too_large');
      handle = await open(target, 'r');
      const actual = await handle.stat();
      if (actual.dev !== inspected.stats.dev || actual.ino !== inspected.stats.ino) throw Error('workspace_file_changed');
      const data = Buffer.alloc(Math.min(maxBytes + 1, actual.size + 1));
      let size = 0;
      while (size < data.length) {
        const read = await handle.read(data, size, data.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      const final = await handle.stat();
      if (size > maxBytes || final.size > maxBytes) throw Error('workspace_file_too_large');
      if (final.size !== size || actual.size !== final.size || actual.mtimeMs !== final.mtimeMs || actual.ctimeMs !== final.ctimeMs) throw Error('workspace_file_changed');
      const identity = await handle.stat({ bigint: true });
      return { status: 'ok', data: data.subarray(0, size), identity: { dev: String(identity.dev), ino: String(identity.ino), birthtimeNs: String(identity.birthtimeNs) } };
    } finally { try { await handle?.close(); } finally { release(); } }
  }

  async validateTextTarget(path, content) {
    const target = this.#path(path);
    if (typeof content !== 'string' || content.includes('\0') || !['.txt', '.md'].includes(extname(target).toLowerCase())) throw Error('workspace_output_invalid');
    if (Buffer.byteLength(content) > 256 * 1024) throw Error('workspace_output_too_large');
    const parent = await this.#inspect(dirname(target));
    if (parent.missing) throw Error('workspace_parent_missing');
    return target;
  }

  async createText(path, content, { onCreated } = {}) {
    if (!['workspace-write', 'full-access'].includes(this.mode)) throw Error('read_only');
    const target = await this.validateTextTarget(path, content);
    const release = await this.#pin(target);
    let handle;
    try {
      await this.#inspect(target);
      try { handle = await open(target, 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') throw Error('workspace_file_exists'); throw error; }
      const identity = await handle.stat({ bigint: true });
      await onCreated?.({ dev: String(identity.dev), ino: String(identity.ino), birthtimeNs: String(identity.birthtimeNs) });
      await handle.writeFile(content, 'utf8');
      await handle.sync();
      return { size: Buffer.byteLength(content) };
    } finally { try { await handle?.close(); } finally { release(); } }
  }

  async readText(path) {
    const result = await this.read(path);
    if (result.status !== 'ok') return result;
    if (result.data.includes(0)) throw Error('workspace_not_text');
    let data;
    try {
      data = new TextDecoder('utf-8', { fatal: true }).decode(result.data);
    } catch {
      throw Error('workspace_not_text');
    }
    return { status: 'ok', data, size: result.data.byteLength, sha256: createHash('sha256').update(result.data).digest('hex') };
  }

  async list(path = '.') {
    const target = this.#path(path);
    const inspected = await this.#inspect(target);
    if (inspected.missing) return { status: 'missing', entries: [] };
    if (!inspected.stats.isDirectory()) throw Error('workspace_not_directory');
    const release = await this.#pin(target, { includeTarget: true });
    try {
      await this.#inspect(target);
      const identity = await workspaceIdentity(target);
      const names = (await readdir(target)).sort((left, right) => left.localeCompare(right));
      const entries = [];
      for (const name of names.slice(0, this.maxEntries)) {
        const child = join(target, name);
        const stats = await lstat(child);
        let type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'reparse';
        if (stats.isSymbolicLink()) type = 'reparse';
        entries.push({ name, type, size: type === 'file' ? stats.size : undefined });
      }
      await assertWorkspaceIdentity(identity);
      await assertWorkspaceIdentity(this.identity);
      return { status: 'ok', entries, truncated: names.length > this.maxEntries };
    } finally { release(); }
  }

  async write(path, data) {
    if (this.mode === 'read-only') throw Error('read_only');
    const target = this.#path(path);
    await this.#assertExistingAncestors(target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
    return target;
  }
}
