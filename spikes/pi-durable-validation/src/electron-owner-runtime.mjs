import { createHarnessFixture } from './harness-fixture.mjs';
import { access } from 'node:fs/promises';
import { cleanupBarrier } from './win32-process.mjs';
import { createHash } from 'node:crypto';
const [path, mode] = process.argv.slice(2);
let fixture;
try {
  process.stdout.write(`RUNTIME_PID=${process.pid}\n`);
  fixture = await createHarnessFixture(path, 'normal', false, {
    marker: m => process.stdout.write(`MARK=${m}\n`),
    cleanup: async () => { await cleanupBarrier(`Local\\PiPersonalAgent.OwnerProbe.${createHash('sha256').update(path).digest('hex')}`);process.stdout.write('MARK=cleanup_complete\n'); },
  });
  fixture.harness.resume(); process.stdout.write('MARK=resume\n');
  await fixture.atomicTransition(); process.stdout.write('MARK=committed\nOWNER_READY\n');
  if (mode === 'hold' || mode === 'single-hold') {
    while (true) { try { await access(`${path}.stop`); break; } catch {} await new Promise(r => setTimeout(r, 20)); }
  }
  await fixture.close(); process.stdout.write('MARK=closed\n'); process.exit(0);
} catch (error) { await fixture?.close().catch(() => {}); await new Promise(r => process.stdout.write(`REJECTED=${error.message}\n`, r)); process.exit(error.message === 'writer_busy' ? 0 : 3); }
