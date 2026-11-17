import { app, utilityProcess } from 'electron';
import { resolve, dirname } from 'node:path';
app.setPath('userData',resolve(dirname(process.argv[3]),`electron-${process.argv[4]?.startsWith('single')?'single':process.pid}`));
if(process.argv[4]?.startsWith('single') && !app.requestSingleInstanceLock()) {
  process.stdout.write('MAIN_REJECTED=single_instance\n',()=>app.exit(0));
} else {
app.whenReady().then(() => {
  const child = utilityProcess.fork(resolve(process.argv[2]), process.argv.slice(3), { stdio: 'pipe' });
  child.stdout?.setEncoding('utf8').on('data', (text) => process.stdout.write(text));
  child.stderr?.setEncoding('utf8').on('data', (text) => process.stderr.write(text));
  const drained = Promise.all([child.stdout, child.stderr].map(stream => new Promise(r => stream.once('end', r))));
  child.once('exit', async (code) => { await drained; process.stdout.write(`RUNTIME_EXIT=${code}\n`, () => app.quit()); });
});
}
