import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../src/runtime/store.mjs';
import { Schedules } from '../src/runtime/schedules.mjs';
test('due schedule instances are atomic, bounded and coalesced across downtime',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-schedules-')); const store=await RuntimeStore.open(join(dir,'agent.sqlite')); t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const schedules=new Schedules(store); const now=Date.now();
 const value=schedules.create({kind:'reminder',text:'喝水',dueAt:now+1000,intervalMs:60000,confirm:true},null,now);
 assert.equal(schedules.claimDue(now).length,0);
 const due=schedules.claimDue(now+181000); assert.equal(due.length,1); assert.equal(due[0].missed,3);
 schedules.begin(due[0].id); schedules.finish(due[0].id, 'fired');
 assert.equal(schedules.claimDue(now+181000).length,0);
 assert.equal(schedules.list()[0].dueAt,now+241000);
 schedules.setEnabled(value.id,value.revision,false);
 assert.equal(schedules.claimDue(now+999999).length,0);
 assert.throws(()=>schedules.delete(value.id,value.revision,true),{code:'schedule_revision_changed'});
 const latest=schedules.list()[0]; schedules.delete(latest.id,latest.revision,true); assert.equal(schedules.list().length,0);
});
test('executing instances recover as interrupted and confirmation is required',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'pi-schedules-')); const store=await RuntimeStore.open(join(dir,'agent.sqlite')); t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
 const schedules=new Schedules(store);const now=Date.now();
 assert.throws(()=>schedules.create({kind:'agent-task',text:'整理',dueAt:now+1000},{}),{code:'schedule_confirmation_required'});
 schedules.create({kind:'agent-task',text:'整理',dueAt:now+1000,confirm:true}, {settingId:'x'}, now);
 const event=schedules.claimDue(now+1001)[0];
 assert.equal(schedules.begin(event.id).status,'executing');
 assert.equal(schedules.begin(event.id),null);
 const restarted=new Schedules(store);assert.equal(restarted.events()[0].status,'interrupted');
 assert.equal(restarted.claimDue(now+1001).length,0);
});

test('pending events remain runnable beyond the history display limit', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-schedules-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const schedules = new Schedules(store);
  const now = Date.now();
  const schedule = schedules.create({ kind: 'reminder', text: 'old', dueAt: now, confirm: true }, null, now);
  const old = schedules.claimDue(now)[0];
  for (let i = 0; i < 105; i++) {
    store.db.prepare("INSERT INTO schedule_events VALUES (?,?,?,'fired',?)").run(`event-${i}`, schedule.id, now + i + 1, '{}');
  }
  assert.equal(schedules.claimDue(now + 200).some(event => event.id === old.id), true);
  assert.equal(schedules.begin(old.id)?.status, 'executing');
});

test('one-time schedules cannot be re-enabled after being claimed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-schedules-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const schedules = new Schedules(store);
  const now = Date.now();
  const schedule = schedules.create({ kind: 'reminder', text: 'once', dueAt: now, confirm: true }, null, now);
  schedules.claimDue(now);
  assert.throws(() => schedules.setEnabled(schedule.id, schedule.revision, true), { code: 'schedule_completed' });
  assert.equal(schedules.get(schedule.id).completed, true);
});

test('invalid repeat intervals and stale completion are rejected', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-schedules-'));
  const store = await RuntimeStore.open(join(dir, 'agent.sqlite'));
  t.after(async () => { store.close(); await rm(dir, { recursive: true, force: true }); });
  const schedules = new Schedules(store);
  const now = Date.now();
  for (const intervalMs of [NaN, null, false, '0', -1]) {
    assert.throws(() => schedules.create({ kind: 'reminder', text: 'invalid', dueAt: now, intervalMs, confirm: true }, null, now), { code: 'schedule_invalid' });
  }
  schedules.create({ kind: 'reminder', text: 'once', dueAt: now, confirm: true }, null, now);
  const event = schedules.claimDue(now)[0];
  schedules.begin(event.id);
  schedules.finish(event.id, 'fired');
  schedules.finish(event.id, 'failed');
  assert.equal(schedules.events()[0].status, 'fired');
});
