import { app, utilityProcess } from 'electron';
import { resolve } from 'node:path';

app.whenReady().then(() => {
  const child = utilityProcess.fork(resolve(process.argv[2]), [], { stdio: 'pipe' });
  let output = '';
  child.on('message', (message) => { output = `RUNTIME_VERSION=${JSON.stringify(message)}`; process.stdout.write(`${output}\n`); });
  child.on('spawn', () => process.stderr.write(`UTILITY_PID=${child.pid}\n`));
  child.stderr?.setEncoding('utf8').on('data', (text) => process.stderr.write(`UTILITY_STDERR=${text}`));
  child.stdout?.setEncoding('utf8').on('data', (text) => process.stderr.write(`UTILITY_STDOUT=${text}`));
  child.once('exit', (code) => {
    if (code !== 0 || !output.includes('RUNTIME_VERSION=')) {
      process.stderr.write(`UTILITY_EXIT=${code}; OUTPUT=${output}\n`);
      process.exitCode = 1;
    }
    app.quit();
  });
});
