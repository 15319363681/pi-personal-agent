import { createHarnessFixture } from './harness-fixture.mjs';
const f = await createHarnessFixture(process.argv[2], process.argv[3]);
await f.root.submit({ type: 'input', content: 'controlled crash', requestId: 'crash-1' }, f.context);
f.harness.resume();
setInterval(() => {}, 1000);
