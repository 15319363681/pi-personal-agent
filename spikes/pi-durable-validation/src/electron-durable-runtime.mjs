import { createHarnessFixture } from './harness-fixture.mjs';
const [path, scenario, mode] = process.argv.slice(2);
let armed = false;
const f = await createHarnessFixture(path, scenario, mode === 'recover', {
  marker: (name) => process.stdout.write(`ORDER=${name}\n`),
  beforeCommit: async () => {
    if (armed && scenario === 'precommit') { process.stdout.write('BOUNDARY=precommit\n'); await new Promise(() => {}); }
  },
});
if (mode === 'crash') {
  if (scenario === 'precommit' || scenario === 'postcommit') {
    armed = true;
    await f.atomicTransition();
    process.stdout.write('BOUNDARY=postcommit\n');
  } else {
    await f.root.submit({ type: 'input', content: 'crash boundary', requestId: 'electron-crash' }, f.context);
    f.harness.resume();
  }
  setInterval(() => {}, 1000);
} else {
  if (!['precommit', 'postcommit'].includes(scenario)) { f.harness.resume(); await f.harness.waitForIdle(f.context); }
  const entries = (await f.root.entries({}, 100, undefined, f.context)).items;
  const result = {
    type: process.type, node: process.versions.node, electron: process.versions.electron,
    journal: (await f.db.get('PRAGMA journal_mode')).journal_mode,
    synchronous: (await f.db.get('PRAGMA synchronous')).synchronous,
    integrity: await f.integrity(), entries, tools: f.toolCalls, modelCalls: f.fake.state.callCount,
    tasks: (await f.harness.inspect(f.context)).tasks,
  };
  await f.close();
  process.parentPort.postMessage(result);
  process.exit(0);
}
