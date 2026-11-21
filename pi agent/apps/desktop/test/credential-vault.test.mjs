import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CredentialVault, migrateLegacyCredentials } from '../src/credential-vault.mjs';

test('credential vault stores only OS-encrypted bytes and never returns the persisted value', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credential-vault-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split('').reverse().join('')),
    decryptString: (value) => Buffer.from(value).toString().split('').reverse().join('')
  };
  try {
    const vault = new CredentialVault({ safeStorage, directory: dir });
    await vault.set('default', 'fresh-secret-value');
    assert.equal(await vault.get('default'), 'fresh-secret-value');
    assert.equal(await vault.has('default'), true);
    assert.doesNotMatch(await readFile(join(dir, 'default.credential'), 'utf8'), /fresh-secret-value/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('credential vault rejects unsupported encryption and unsafe profile ids', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credential-vault-'));
  try {
    const vault = new CredentialVault({ safeStorage: { isEncryptionAvailable: () => false }, directory: dir });
    await assert.rejects(vault.set('default', 'secret'), /credential_encryption_unavailable/);
    await assert.rejects(vault.set('../escape', 'secret'), /invalid_credential_id/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});


test('legacy keys migrate to encrypted storage before plaintext is removed and retries preserve existing vault keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credential-migration-'));
  const path = join(dir, 'model-settings.json');
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value.split('').reverse().join('')), decryptString: (bytes) => bytes.toString().split('').reverse().join('') };
  try {
    const vault = new CredentialVault({ safeStorage, directory: join(dir, 'vault') });
    await writeFile(path, JSON.stringify([{ id: 'old', model: 'm', apiKey: 'legacy-secret' }]));
    await migrateLegacyCredentials({ path, vault });
    assert.equal(await vault.get('old'), 'legacy-secret');
    assert.doesNotMatch(await readFile(path, 'utf8'), /legacy-secret|apiKey/);
    const conflictingSettings = JSON.stringify([{ id: 'old', apiKey: 'outdated-secret' }]);
    await writeFile(path, conflictingSettings);
    await assert.rejects(migrateLegacyCredentials({ path, vault }), /credential_migration_conflict/);
    assert.equal(await readFile(path, 'utf8'), conflictingSettings);
    assert.equal(await vault.get('old'), 'legacy-secret');
    await writeFile(path, JSON.stringify([{ id: 'old', apiKey: 'legacy-secret' }]));
    await migrateLegacyCredentials({ path, vault });
    assert.doesNotMatch(await readFile(path, 'utf8'), /legacy-secret|apiKey/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy plaintext remains intact if encrypted migration fails', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credential-migration-fail-'));
  const path = join(dir, 'model-settings.json');
  const original = JSON.stringify([{ id: 'old', apiKey: 'legacy-secret' }]);
  try {
    await writeFile(path, original);
    const vault = new CredentialVault({ safeStorage: { isEncryptionAvailable: () => false }, directory: join(dir, 'vault') });
    await assert.rejects(migrateLegacyCredentials({ path, vault }), /credential_encryption_unavailable/);
    assert.equal(await readFile(path, 'utf8'), original);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('legacy migration does not overwrite settings changed while credentials are being encrypted', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-credential-migration-race-'));
  const path = join(dir, 'model-settings.json');
  const original = JSON.stringify([{ id: 'old', model: 'old-model', apiKey: 'legacy-secret' }]);
  const updated = JSON.stringify([{ id: 'new', model: 'new-model' }]);
  let resumeVaultRead;
  let vaultReadStarted;
  const gate = new Promise((resolve) => { resumeVaultRead = resolve; });
  const started = new Promise((resolve) => { vaultReadStarted = resolve; });
  const safeStorage = { isEncryptionAvailable: () => true, encryptString: (value) => Buffer.from(value), decryptString: (bytes) => bytes.toString() };
  try {
    await writeFile(path, original);
    const vault = new CredentialVault({ safeStorage, directory: join(dir, 'vault') });
    const actualGet = vault.get.bind(vault);
    vault.get = async (id) => {
      vaultReadStarted();
      await gate;
      return actualGet(id);
    };
    const migration = migrateLegacyCredentials({ path, vault });
    await started;
    await writeFile(path, updated);
    resumeVaultRead();
    await assert.rejects(migration, /credential_migration_settings_changed/);
    assert.equal(await readFile(path, 'utf8'), updated);
    assert.equal(await vault.has('old'), false, 'aborted migration removes credentials it created');
  } finally { resumeVaultRead?.(); await rm(dir, { recursive: true, force: true }); }
});
