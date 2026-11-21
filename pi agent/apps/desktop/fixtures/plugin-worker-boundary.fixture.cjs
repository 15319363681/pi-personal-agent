'use strict';
// Trusted OS-boundary fixture. Launched directly through the native process API,
// never through the production plugin interface.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const dgram = require('node:dgram');
const http = require('node:http');
const { spawn } = require('node:child_process');
const request = JSON.parse(fs.readFileSync(path.join(__dirname, 'input.json'), 'utf8'));
const output = path.join(__dirname, 'output');
function attempt(operation) {
  try { operation(); return 'allowed'; }
  catch (cause) { return cause.code || 'error'; }
}
function network(kind, port) {
  return new Promise((resolve) => {
    let socket, timer;
    let finished = false;
    const done = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (kind === 'udp') socket.close();
      else socket.destroy();
      resolve(value);
    };
    timer = setTimeout(() => done('timeout'), 1200);
    if (kind === 'udp') {
      socket = dgram.createSocket('udp4');
      socket.once('error', (cause) => done(cause.code));
      socket.once('message', () => done('allowed'));
      socket.send(Buffer.from('pi-worker-probe'), port, '127.0.0.1', (cause) => { if (cause) done(cause.code); });
    } else if (kind === 'http') {
      socket = http.get({ host: '127.0.0.1', port, path: '/worker-boundary' }, (response) => {
        response.resume();
        response.once('end', () => done('allowed'));
      });
      socket.once('error', (cause) => done(cause.code));
    } else {
      socket = net.connect({ host: '127.0.0.1', port }, () => socket.write('pi-worker-probe'));
      socket.once('data', () => done('allowed'));
      socket.once('error', (cause) => done(cause.code));
    }
  });
}
(async () => {
  if (request.hang) {
    fs.writeFileSync(path.join(output, 'started.json'), JSON.stringify({ pid: process.pid }));
    setInterval(() => {}, 1000);
    return;
  }
  const result = { environment: process.env, argv: process.argv.slice(2) };
  result.inside = attempt(() => fs.writeFileSync(path.join(output, 'inside.txt'), 'inside'));
  result.read = attempt(() => fs.readFileSync(request.protectedFile, 'utf8'));
  result.write = attempt(() => fs.writeFileSync(request.protectedFile, 'protected'));
  result.create = attempt(() => {
    fs.writeFileSync(request.outsideNewFile, 'outside');
    fs.unlinkSync(request.outsideNewFile);
  });
  result.spawn = await new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [...(process.versions.electron ? ['--no-stdio-init'] : []), '-e', 'process.exit(0)'], { stdio: 'ignore', windowsHide: true });
    } catch (cause) {
      resolve(cause.code);
      return;
    }
    child.once('error', (cause) => resolve(cause.code));
    child.once('exit', (code) => resolve(code === 0 ? 'allowed' : 'exit:' + code));
  });
  for (const kind of ['tcp', 'udp', 'http']) result[kind] = await network(kind, request.ports[kind]);
  fs.writeFileSync(path.join(output, 'boundary.json'), JSON.stringify(result));
  process.exit(0);
})().catch((cause) => {
  fs.writeFileSync(path.join(output, 'boundary-error.json'), JSON.stringify({ code: cause.code, message: cause.message, stack: cause.stack }));
  process.exit(1);
});