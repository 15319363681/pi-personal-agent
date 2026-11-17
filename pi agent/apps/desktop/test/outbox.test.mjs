import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { Outbox } from '../src/runtime/outbox.mjs';
import { LocalFileProvider } from '../src/runtime/providers/local-file.mjs';

test('local file provider delivers completion notification once', async()=>{const dir=await mkdtemp(join(tmpdir(),'pi-product-outbox-'));try{const store=await RuntimeStore.open(join(dir,'agent.sqlite'));const event=store.enqueueOutbox({kind:'task.completed',taskId:'t1',target:join(dir,'notify')});const result=await new Outbox(store).dispatch(event.id,new LocalFileProvider());assert.equal(result.status,'delivered');assert.match(await readFile(result.path,'utf8'),/task.completed/);store.close();}finally{await rm(dir,{recursive:true,force:true});}});
