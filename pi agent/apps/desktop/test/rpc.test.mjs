import test from 'node:test'; import assert from 'node:assert/strict'; import {EventEmitter} from 'node:events'; import {encode,decodeLines,RpcClient} from '../src/rpc.mjs';
test('rpc framing round trips newline-delimited JSON',()=>{const line=encode({id:1,method:'ping'});assert.deepEqual(decodeLines(line+'\n'),[{id:1,method:'ping'}]);});
test('rpc client correlates responses over a child process stream',async()=>{const stdout=new EventEmitter();const proc=new EventEmitter();proc.stdout=stdout;proc.stdin={write(line){const req=JSON.parse(line);setImmediate(()=>stdout.emit('data',Buffer.from(`${JSON.stringify({id:req.id,ok:true,result:{echo:req.method}})}\n`)));}};const client=new RpcClient(proc);assert.deepEqual(await client.request('ping',{value:1}),{ok:true,result:{echo:'ping'}});});


test('rpc close ends input, waits for graceful exit and refuses new requests', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  let ended = false;
  let killed = false;
  child.stdin = { end() { ended = true; }, write() {} };
  child.kill = () => { killed = true; };
  const client = new RpcClient(child);
  let completed = false;
  const closing = client.close().then(() => { completed = true; });
  assert.equal(ended, true);
  await assert.rejects(client.request('ping'), /runtime_closed/);
  await new Promise(setImmediate);
  assert.equal(completed, false);
  assert.equal(killed, false);
  child.emit('exit', 0);
  child.emit('close', 0);
  await closing;
  assert.equal(completed, true);
  assert.equal(killed, false);
  await client.close();
});


test('rpc close terminates an unresponsive Runtime after its grace period', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  let killed = false;
  child.stdin = { end() {}, write() {} };
  child.kill = () => { killed = true; child.emit('exit', 1); child.emit('close', 1); };
  const client = new RpcClient(child);
  await client.close({ timeoutMs: 5 });
  assert.equal(killed, true);
});
