import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import tls from 'node:tls';
import { createProfile } from './win32-process.mjs';
import { launchChain } from './windows-chain-driver.mjs';
import { checkWorkspace } from './workspace-admission.mjs';
const exec = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), 'pi-ac-'));
const workspace = join(dir, 'workspace'); const readonly = join(dir, 'readonly');
const bin = resolve('../windows-worker/bin'); const exe = join(bin, 'Win32Probe.exe');
let profile, chain; const servers = []; const sockets = new Set();
let receipts = { tcp: 0, udp: 0, dns: 0, http: 0, https: 0 };
const bind = async (server) => { await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); }); servers.push(server); return server.address().port; };
const track = (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); };
const acl = async (path, rights) => exec('icacls.exe', [path, '/grant', `*${profile.string}:${rights}`], { windowsHide: true });
try {
  await mkdir(workspace); await mkdir(readonly);
  const inside = join(workspace, 'inside.txt'), outside = join(dir, 'outside.txt'), ro = join(readonly, 'ro.txt');
  for (const path of [inside, outside, ro]) await writeFile(path, 'fixture\n');
  const hardlink=join(workspace,'hardlink.txt'); await link(outside,hardlink);
  assert.equal(await readFile(hardlink,'utf8'),'fixture\n');
  await assert.rejects(checkWorkspace(workspace),/hardlink_denied/);await rm(hardlink);
  await checkWorkspace(workspace);
  // Deliberately inject a junction AFTER admission to exercise OS denial too.
  await symlink(dir, join(workspace, 'escape'), 'junction');
  const key = join(dir, 'tls.key'), cert = join(dir, 'tls.crt');
  const conf = join(dir, 'openssl.cnf'); await writeFile(conf, '[req]\ndistinguished_name=dn\n[dn]\n');
  await exec('openssl.exe', ['req', '-config', conf, '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=pi-spike.invalid'], { windowsHide: true });
  const tcp = net.createServer((s) => { track(s); s.on('data', (data) => { receipts.tcp++; s.end(data); }); });
  const tcpPort = await bind(tcp);
  const udp = dgram.createSocket('udp4'); await new Promise((done) => udp.bind(0, '127.0.0.1', done)); servers.push(udp);
  udp.on('message', (data, peer) => { receipts[data[0] === 0x12 ? 'dns' : 'udp']++; udp.send(data, peer.port, peer.address); });
  const web = http.createServer((_request, response) => { receipts.http++; response.end('P'); }); web.on('connection', track);
  const httpPort = await bind(web);
  const secure = tls.createServer({ key: await readFile(key), cert: await readFile(cert) }, (s) => { track(s); s.on('data', (data) => { receipts.https++; s.end(data); }); }); secure.on('tlsClientError', () => {}); secure.on('connection', track);
  const httpsPort = await bind(secure);
  const args = ['boundary', inside, outside, join(workspace, 'escape', 'outside.txt'), ro, '127.0.0.1', String(tcpPort), String(udp.address().port), String(httpPort), String(httpsPort)];
  // Same executable, files, junction and live endpoints. Failure of any positive control fails the gate.
  const controlPath = join(workspace, 'ordinary.txt');
  await exec(exe, [...args, controlPath, '2'], { timeout: 65000, windowsHide: true });
  const control = await readFile(controlPath, 'utf8');
  assert(!control.includes('denied:'), `positive_control_failed:\n${control}`);
  assert(receipts.tcp > 0 && receipts.udp > 0 && receipts.dns > 0 && receipts.http >= 2 && receipts.https > 0, 'missing_server_receipt');
  console.log('POSITIVE_CONTROLS', control.trim().replaceAll('\r\n', ','), JSON.stringify(receipts));
  profile = createProfile(`Pi.Spike.${process.pid}.${Date.now()}`);
  await acl(dir, '(RX)'); await acl(bin, '(OI)(CI)(RX)'); await acl(workspace, '(OI)(CI)(M)'); await acl(readonly, '(OI)(CI)(RX)');
  await exec('icacls.exe', [workspace, '/setintegritylevel', '(OI)(CI)L'], { windowsHide: true });
  const restrictedPath = join(workspace, 'restricted.txt');
  const before = { ...receipts };
  chain = await launchChain({ mode: 'boundary', exe, args: [...args, restrictedPath, '2'], cwd: workspace, databasePath: join(dir, 'state.sqlite'), sid: profile.string, jobName: `Local\\PiPersonalAgent.Spike.Boundary.${process.pid}` }, join(dir, 'payload.json'));
  await chain.waitFor('complete', 65000); assert.equal(await chain.exited, 0);
  const restricted = Object.fromEntries((await readFile(restrictedPath, 'utf8')).trim().split(/\r?\n/).map((row) => row.split('=')));
  for (const name of ['inside_read', 'inside_write', 'readonly_read']) assert.equal(restricted[name], 'ok', `${name} failed`);
  for (const name of ['outside_read', 'outside_write', 'traversal', 'junction', 'readonly_write', 'tcp', 'udp', 'dns', 'http', 'https', 'proxy']) assert(restricted[name]?.startsWith('denied:'), `${name} escaped: ${restricted[name]}`);
  assert.deepEqual(receipts, before, 'restricted_worker_reached_network');
  for(const suffix of ['', '.child', '.child.child']) {
    const rows=Object.fromEntries((await readFile(restrictedPath+suffix,'utf8')).trim().split(/\r?\n/).map(row=>row.split('=')));
    const controls=await readFile(controlPath+suffix,'utf8');assert(!controls.includes('denied:'),'descendant_control_failed');
    assert.equal(rows.appcontainer,'1');assert.equal(rows.in_job,'1');
    for(const name of ['outside_read','outside_write','traversal','junction','readonly_write','tcp','udp','dns','http','https','proxy'])assert(rows[name]?.startsWith('denied:'),`descendant_escape:${suffix}:${name}`);
    console.log('DESCENDANT_BOUNDARY',suffix||'worker',JSON.stringify(rows));
  }
  // Broker checks exact origin before opening a socket; test never contacts another host.
  const approved = `http://127.0.0.1:${httpPort}`;
  async function broker(url) { if (new URL(url).origin !== approved) throw new Error('scope_denied'); return new Promise((done, reject) => { http.get(url, (r) => { r.resume(); r.on('end', () => done('ok')); }).on('error', reject); }); }
  assert.equal(await broker(`${approved}/approved`), 'ok'); const count = receipts.http;
  await assert.rejects(broker('http://localhost/changed-recipient'), /scope_denied/); assert.equal(receipts.http, count);
  console.log('RESTRICTED_RESULTS', JSON.stringify(restricted), 'network_receipts_unchanged', JSON.stringify(before));
  console.log('PROBE_PASS appcontainer-boundary');
} finally {
  if (chain?.child.exitCode === null) { chain.child.kill(); await chain.exited; }
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((s) => new Promise((done) => s.close(done))));
  if (profile) { await exec('icacls.exe', [bin, '/remove:g', `*${profile.string}`], { windowsHide: true }); profile.close(); }
  await rm(dir, { recursive: true, force: true });
}
