import { acquireWriter } from './windows-writer-lock.mjs';
const [key, mode] = process.argv.slice(2);
try {
  const lease = acquireWriter(key, mode === 'hold' ? 0xFFFFFFFF : 100);
  process.stdout.write(`RUNTIME_LOCKED abandoned=${lease.abandoned}\n`);
  if (mode === 'hold') await new Promise(() => {});
  lease.release();
  process.exit(0);
} catch (error) {
  process.stdout.write(`RUNTIME_REJECTED ${error.message}\n`);
  process.exit(3);
}
