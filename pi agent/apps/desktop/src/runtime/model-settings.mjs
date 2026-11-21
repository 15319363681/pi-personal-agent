import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

async function load(path) {
  try {
    const entries = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(entries)) throw Error('model_settings_invalid');
    return entries;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.id !== undefined && (typeof value.id !== 'string' || !value.id.trim() || value.id.length > 120)) ||
      (value.name !== undefined && (typeof value.name !== 'string' || value.name.trim().length > 80)) ||
      (value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean')) {
    throw Object.assign(Error('模型配置名称或能力字段无效'), { code: 'model_setting_invalid' });
  }
}

export class ModelSettings {
  constructor(path) {
    this.path = path;
    this.secrets = new Map();
    this.tail = Promise.resolve();
  }

  #mutate(operation) {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }

  async #save(entries) {
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(temporary, JSON.stringify(entries, null, 2), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  upsert(value) {
    return this.#mutate(async () => {
      validateMetadata(value);
      const id = value.id ?? 'default';
      const all = await load(this.path);
      const index = all.findIndex((entry) => entry.id === id);
      const previous = index < 0 ? {} : all[index];
      const safe = {
        id,
        revision: randomUUID(),
        provider: value.provider,
        model: value.model,
        baseUrl: value.baseUrl,
        apiFormat: value.apiFormat ?? 'chat-completions',
        credentialRef: value.credentialRef ?? previous.credentialRef,
        name: value.name === undefined ? previous.name : value.name.trim(),
        supportsImages: value.supportsImages ?? previous.supportsImages ?? false
      };
      if (index < 0) all.push(safe);
      else all[index] = safe;
      await this.#save(all);
      if (value.apiKey) this.secrets.set(id, value.apiKey);
      return this.#public(safe);
    });
  }

  remove(id) {
    return this.#mutate(async () => {
      const all = await load(this.path);
      const entry = all.find((item) => item.id === id);
      if (!entry) return null;
      await this.#save(all.filter((item) => item.id !== id));
      this.secrets.delete(id);
      return this.#public(entry);
    });
  }

  async list() {
    await this.tail;
    return (await load(this.path)).map((entry) => this.#public(entry));
  }

  async get(id) { return (await this.list()).find((entry) => entry.id === id) ?? null; }

  async getSecret(id) {
    await this.tail;
    return this.secrets.has(id) ? { apiKey: this.secrets.get(id) } : null;
  }

  #public(entry) {
    const { apiKey: _secret, ...safe } = entry;
    return { ...safe, hasApiKey: Boolean(entry.credentialRef) || this.secrets.has(entry.id) };
  }
}
