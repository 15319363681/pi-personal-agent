import { acquireWriter } from './windows-writer-lock.mjs';
const [mode, name] = process.argv.slice(2);
try {
  const lease = acquireWriter(name, mode === 'try' ? 100 : 0xFFFFFFFF);
  process.stdout.write(`LOCKED abandoned=${lease.abandoned}\n`);
  if (mode === 'hold') await new Promise((resolve) => process.stdin.once('data', resolve));
  lease.release();
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(2);
}
