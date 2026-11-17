import { app, utilityProcess } from 'electron';
import { resolve } from 'node:path';
app.whenReady().then(() => {
  const child = utilityProcess.fork(resolve(process.argv[2]), process.argv.slice(3), { stdio: 'pipe' });
  child.on('message', (message) => process.stdout.write(`STORAGE_RESULT=${JSON.stringify(message)}\n`));
  child.stdout?.setEncoding('utf8').on('data', (text) => process.stdout.write(text));
  child.stderr?.setEncoding('utf8').on('data', (text) => process.stderr.write(text));
  child.once('exit', (code) => { process.stderr.write(`UTILITY_EXIT=${code}\n`); if (code !== 0) process.exitCode = code; app.quit(); });
});
