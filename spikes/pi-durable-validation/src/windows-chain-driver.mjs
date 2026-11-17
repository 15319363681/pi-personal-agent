import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
export async function launchChain(payload, path) {
  await writeFile(path, JSON.stringify(payload));
  const child = spawn(require('electron'), [resolve('src/electron-worker-main.mjs'), path], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const events = []; let errors = ''; let pending = '';
  child.stdout.setEncoding('utf8').on('data', (text) => {
    pending += text; errors += `STDOUT:${text}`;
    while (pending.includes('\n')) { const end = pending.indexOf('\n'); const line = pending.slice(0, end); pending = pending.slice(end + 1); if (line.startsWith('CHAIN=')) events.push(JSON.parse(line.slice(6))); }
  });
  child.stderr.setEncoding('utf8').on('data', (text) => { errors += text; });
  let closed = false;
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('close', (code) => { closed = true; errors += ` EXIT=${code}`; done(code); }); });
  return {
    child, events, exited,
    async waitFor(type, ms = 18000) {
      const deadline = Date.now() + ms;
      while (true) {
        const fail = events.find((e) => e.type === 'failure'); if (fail) throw new Error(JSON.stringify(fail));
        const event = events.find((e) => e.type === type); if (event) return event;
        if (closed || Date.now() > deadline) throw new Error(`chain_missing:${type}; events=${JSON.stringify(events)}; stderr=${errors}`);
        await new Promise((done) => setTimeout(done, 20));
      }
    },
  };
}
