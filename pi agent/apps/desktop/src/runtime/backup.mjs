import { mkdir, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export class BackupManager {
  constructor(store, dir) { this.store = store; this.dir = dir; }

  async create() {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${Date.now()}-${randomUUID()}.sqlite`);
    const source = new DatabaseSync(this.store.path);
    try {
      // DatabaseSync in the supported Electron/Node runtime does not expose
      // the newer backup() helper. VACUUM INTO is SQLite's portable online
      // snapshot primitive and preserves a consistent database image.
      source.prepare('VACUUM INTO ?').run(path);
    } finally {
      try { source.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {}
      source.close();
    }
    return path;
  }

  async restore(path) {
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      const ok = check.prepare('PRAGMA integrity_check').get().integrity_check === 'ok';
      if (!ok) throw Error('backup_corrupt');
    } finally { check.close(); }

    // Freeze before replacing the image. The caller must close/reopen the
    // writer and explicitly clear recovery_mode after reconciliation.
    this.store.close();
    await copyFile(path, this.store.path);
    // A copied WAL/SHM pair would describe a different snapshot; remove any
    // stale sidecars before the next RuntimeStore.open().
    await Promise.allSettled([
      rm(`${this.store.path}-wal`, { force: true }),
      rm(`${this.store.path}-shm`, { force: true })
    ]);
    const restored = new DatabaseSync(this.store.path);
    try { restored.prepare('INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)').run('recovery_mode', 'true'); }
    finally { try { restored.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch {} restored.close(); }
  }
}
