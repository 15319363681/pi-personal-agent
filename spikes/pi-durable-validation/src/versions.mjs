import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const pkgVersion = (name) => {
  return require(resolve(root, '..', 'node_modules', name, 'package.json')).version;
};

export async function measureVersions() {
  const main = resolve(root, 'electron-main-probe.mjs');
  const child = resolve(root, 'electron-runtime-version-probe.mjs');
  return new Promise((resolveResult, reject) => {
    const electron = spawn(require('electron'), [main, child], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    electron.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    electron.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    const timer = setTimeout(() => { electron.kill(); reject(new Error(`Electron probe timed out: ${stderr}`)); }, 30000);
    electron.once('error', (error) => { clearTimeout(timer); reject(error); });
    electron.once('close', (code) => {
      clearTimeout(timer);
      const line = stdout.split(/\r?\n/).find((row) => row.startsWith('RUNTIME_VERSION='));
      if (code !== 0 || !line) return reject(new Error(`Electron probe exit=${code}; stdout=${stdout}; stderr=${stderr}`));
      resolveResult({ hostNode: process.versions.node, pi: ['@earendil-works/pi-durable', '@earendil-works/pi-ai', '@earendil-works/chord'].map(pkgVersion), runtime: JSON.parse(line.slice('RUNTIME_VERSION='.length)) });
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  measureVersions().then((value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)).catch((error) => { console.error(error); process.exitCode = 1; });
}
