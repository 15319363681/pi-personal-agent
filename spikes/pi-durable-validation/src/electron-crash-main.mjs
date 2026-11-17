import { app, utilityProcess } from 'electron';
import { resolve } from 'node:path';
app.whenReady().then(() => {
  const child = utilityProcess.fork(resolve(process.argv[2]), process.argv.slice(3), { stdio: 'pipe' });
  child.stdout.setEncoding('utf8').on('data', (text) => {
    process.stdout.write(text);
    if (text.includes('READY_TO_KILL') || text.includes('BOUNDARY=')) child.kill();
  });
  child.stderr.setEncoding('utf8').on('data', (text) => process.stderr.write(text));
  child.once('exit', (code) => { process.stdout.write(`KILLED_EXIT=${code}\n`); app.quit(); });
});
