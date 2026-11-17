import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { SqliteStorage, CURRENT_SQLITE_SCHEMA_VERSION } from '@earendil-works/pi-durable/storage/sqlite';
import { createModels, fauxProvider } from '@earendil-works/pi-ai';

// Version-pinned public DB facade: validate existing schema, suppress ONLY the two
// idempotent migration bootstrap statements. All actual write SQL remains denied.
export async function openObserver(path) {
  const db = await openNodeSqliteDatabase(path, { mode: 'read-only' });
  try {
    const row = await db.get('SELECT version FROM durable_schema WHERE singleton=1');
    if (row?.version !== CURRENT_SQLITE_SCHEMA_VERSION) throw Error('observer_schema_mismatch');
    let bootstrap = true;
    const normalize = s => s.replace(/\s+/g, ' ').trim();
    const blocked = () => { throw Error('observer_write_denied'); };
    const wrap = tx => ({
      get: (...args) => tx.get(...args), all: (...args) => tx.all(...args),
      exec: async sql => {
        if (bootstrap && normalize(sql) === 'CREATE TABLE IF NOT EXISTS durable_schema ( singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0) ) STRICT') return;
        blocked();
      },
      run: async sql => { if (bootstrap && normalize(sql) === 'INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)') return; blocked(); },
      runCounted: blocked,
    });
    const facade = { ...wrap(db), transaction: cb => db.transaction(tx => cb(wrap(tx))), close: () => db.close() };
    const storage = await SqliteStorage.open(facade); bootstrap = false;
    const fake = fauxProvider(); const models = createModels(); models.setProvider(fake.provider);
    const harness = await Harness.open(storage, { models, registry: createRegistry(), readOnly: true }, context);
    return { harness, context, writes: async () => (await db.get('SELECT total_changes() AS n')).n, modelCalls: () => fake.state.callCount, close: () => harness.close(context) };
  } catch (error) { await db.close().catch(() => {}); throw error; }
}

