import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node';
import { Harness, createRegistry, defineTask, defineTool, defineExtension } from '@earendil-works/pi-durable';
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite';
import { createModels, fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { acquireWriter } from './windows-writer-lock.mjs';

export async function createHarnessFixture(path, scenario = 'normal', recovering = false, options = {}) {
  const lease = acquireWriter(path, 0);
  let db, harness;
  try {
  options.marker?.('lease_acquired');
  await options.cleanup?.();
  db = await (options.databaseFactory ?? openNodeSqliteDatabase)(path);
  options.marker?.('writable_open');
  await db.exec('PRAGMA synchronous=FULL');
  if ((await db.get('PRAGMA integrity_check')).integrity_check !== 'ok') { await db.close(); lease.release(); throw new Error('integrity_check_failed'); }
  options.marker?.('integrity_ok');
  let fail = false;
  const facade = {
    exec: (...args) => db.exec(...args), run: (...args) => db.run(...args),
    get: (...args) => db.get(...args), all: (...args) => db.all(...args), close: () => db.close(),
    transaction: (callback) => db.transaction(async (tx) => {
      const result = await callback(tx);
      if (options.beforeCommit) await options.beforeCommit(tx);
      if (fail) { fail = false; throw new Error('injected_before_commit'); }
      return result;
    }),
  };
  const storage = await SqliteStorage.open(facade);
  const fake = fauxProvider();
  const models = createModels(); models.setProvider(fake.provider);
  const toolCalls = [];
  const boundary = (name) => { process.stdout.write(`BOUNDARY=${name}\n`); return new Promise(() => {}); };
  const checkpoint = defineTask({
    name: 'spike.checkpoint', version: 1,
    initial: () => ({ phase: 'saved', marker: 42 }),
    phases: { saved: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: 'terminal', outcome: { type: 'success', value: 42 } }), ctx); } },
    abort: async (_task, runtime, ctx) => { await runtime.commit(() => ({ status: 'terminal', outcome: { type: 'cancelled' } }), ctx); },
  });
  const probe = defineTool({
    name: 'probe', description: 'Controlled no-side-effect crash boundary',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    ...(scenario === 'safeTool' ? { replay: 'safe' } : {}),
    execute: async () => {
      toolCalls.push('probe');
      if (!recovering) return boundary('tool');
      return { output: [{ type: 'text', text: 'tool complete' }] };
    },
  });
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'spike', tasks: [checkpoint], tools: [probe] }));
  const done = fauxAssistantMessage([fauxText('done')]);
  if (scenario === 'blockedModel' && !recovering) fake.setResponses([() => boundary('model')]);
  else if ((scenario === 'safeTool' || scenario === 'unsafeTool') && !recovering)
    fake.setResponses([fauxAssistantMessage([fauxToolCall('probe', {})], { stopReason: 'toolUse' }), done]);
  else fake.setResponses([done]);
  harness = await Harness.open(storage, {
    models, registry, settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } },
    onReport: (r) => process.stderr.write(`REPORT=${r.kind}:${String(r.error)}\n`),
  }, context);
  harness.closed.then(() => lease.release());
  options.marker?.('harness_open');
  const root = await harness.root(context, { agent: { model: { provider: fake.provider.name, modelId: fake.getModel().id } } });
  return {
    harness, root, fake, context, toolCalls, db, storage,
    close: () => harness.close(context),
    integrity: async () => (await db.get('PRAGMA integrity_check')).integrity_check,
    failNextTransaction: () => { fail = true; },
    createCheckpoint: () => root.commit((tx) => tx.createTask(checkpoint, {}, { ownership: { kind: 'conversation' } }), context),
    atomicTransition: () => root.commit(async (tx) => {
      for (const kind of ['task', 'approval', 'budgetReservation', 'permissionSnapshot', 'pluginVersion', 'outbox'])
        await tx.appendEntry(root.id, { kind: `spike.business.${kind}`, data: { taskVersion: 1, contractHash: 'fixture-contract', marker: 42 } });
      return tx.createTask(checkpoint, {}, { ownership: { kind: 'conversation' } });
    }, context),
    entrySequences: (rows) => Promise.all(rows.map(async (row) => (await storage.entry(row.id, context)).commitSeq)),
  };
  } catch (error) {
    try { if (harness) await harness.close(context); else if (db) await db.close(); } catch {}
    lease.release();
    throw error;
  }
}
