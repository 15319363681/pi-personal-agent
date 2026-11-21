import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class CredentialVault {
  constructor({ safeStorage, directory }) { this.safeStorage = safeStorage; this.directory = directory; }

  #path(id) {
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new Error('invalid_credential_id');
    return join(this.directory, `${id}.credential`);
  }

  async #assertAvailable() {
    if (!this.safeStorage?.isEncryptionAvailable()) throw new Error('credential_encryption_unavailable');
  }

  async set(id, secret) {
    const path = this.#path(id);
    await this.#assertAvailable();
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(this.safeStorage.encryptString(secret).toString('base64'), 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }

  async get(id) {
    await this.#assertAvailable();
    try { return this.safeStorage.decryptString(Buffer.from(await readFile(this.#path(id), 'utf8'), 'base64')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }

  async has(id) {
    try { return (await readFile(this.#path(id))).length > 0; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }

  async delete(id) { await rm(this.#path(id), { force: true }); }
}


export async function migrateLegacyCredentials({ path, vault }) {
  let entries;
  let originalContents;
  try { originalContents = await readFile(path, 'utf8'); entries = JSON.parse(originalContents); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (!Array.isArray(entries)) throw new Error('invalid_model_settings');
  if (!entries.some((entry) => Object.hasOwn(entry, 'apiKey'))) return;

  const createdCredentialIds = new Set();
  for (const entry of entries) {
    if (!Object.hasOwn(entry, 'apiKey') || !entry.apiKey) continue;
    const id = String(entry.id ?? 'default');
    const existing = await vault.get(id);
    if (existing !== null && existing !== entry.apiKey) throw new Error('credential_migration_conflict');
    if (existing === null) {
      await vault.set(id, entry.apiKey);
      createdCredentialIds.add(id);
    }
    if (await vault.get(id) !== entry.apiKey) throw new Error('credential_migration_verification_failed');
  }
  const safe = entries.map(({ apiKey, ...entry }) => entry);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    if (await readFile(path, 'utf8') !== originalContents) throw new Error('credential_migration_settings_changed');
    await writeFile(temporary, JSON.stringify(safe, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    if (await readFile(path, 'utf8') !== originalContents) throw new Error('credential_migration_settings_changed');
    await rename(temporary, path);
  } catch (error) {
    if (error.message === 'credential_migration_settings_changed' && createdCredentialIds.size > 0) {
      try {
        const currentEntries = JSON.parse(await readFile(path, 'utf8'));
        if (Array.isArray(currentEntries)) {
          const referencedIds = new Set(currentEntries.map((entry) => String(entry.credentialRef ?? entry.id ?? 'default')));
          for (const id of createdCredentialIds) {
            if (!referencedIds.has(id)) await vault.delete?.(id);
          }
        }
      } catch {
        // Retain credentials when the current settings references cannot be established.
      }
    }
    throw error;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}
