import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { Harness, createRegistry } from '@earendil-works/pi-durable';
import { createModels } from '@earendil-works/pi-ai/models';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';

const databasePath = process.argv[2];
const db = await openNodeSqliteDatabase(databasePath);
// Durable's adapter defaults to NORMAL; raise durability on its exact connection before Harness opens it.
await db.exec('PRAGMA synchronous = FULL');
const harness = await Harness.open(await SqliteStorage.open(db), { models: createModels(), registry: createRegistry() }, BACKGROUND_CONTEXT);
const pragmas = {
  journalMode: (await db.get('PRAGMA journal_mode')).journal_mode,
  synchronous: (await db.get('PRAGMA synchronous')).synchronous,
};
const root = await harness.root(BACKGROUND_CONTEXT);
const phase = process.argv[3];
if (phase === 'write' || phase === 'crash') {
  await root.submit({ type: 'write', entry: { kind: 'spike.checkpoint', data: { marker: 'durable-row-1' } } }, BACKGROUND_CONTEXT);
} else if (phase !== 'crash') {
  const entries = await root.entries({}, 20, undefined, BACKGROUND_CONTEXT);
  if (!entries.items.some((entry) => entry.kind === 'spike.checkpoint' && entry.data?.marker === 'durable-row-1')) throw new Error('checkpoint missing after reopen');
}
const result = { phase, pragmas, node: process.versions.node, electron: process.versions.electron, type: process.type };
if (phase === 'crash') {
  process.stdout.write('READY_TO_KILL\n');
  await new Promise(() => {});
}
await harness.close(BACKGROUND_CONTEXT);
process.stdout.write(`PROBE_RESULT=${JSON.stringify(result)}\n`);
process.parentPort.postMessage(result);
process.exit(0);
