import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { WSClient } from '@wecom/aibot-node-sdk';
import { WecomService } from '../src/wecom-service.mjs';
import { createRuntimeRequestHandler } from '../src/runtime-request.mjs';
async function until(check) { for(let i=0;i<150;i++) { const result=await check(); if(result) return result; await new Promise(resolve=>setTimeout(resolve,20)); } assert.fail('channel condition timed out'); }
const message = (id, patch = {}) => ({ cmd: 'aibot_msg_callback', headers: { req_id: 'request-' + id }, body: { msgid: id, chattype: 'single', aibotid: 'bot1', from: { userid: 'owner' }, msgtype: 'text', text: { content: '本人的请求' }, ...patch } });
function vault() { const values=new Map(); return { get: async id=>values.get(id), set: async (id,value)=>values.set(id,value), has: async id=>values.has(id), delete: async id=>values.delete(id) }; }
test('official SDK authenticates, replies only to owner and reconnects without replaying a message', { timeout: 15000 }, async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  let socket, connections=0, handled=0, config=null;
  const claims = new Set(), frames=[];
  server.on('connection', client => {
    socket=client; connections++;
    client.on('message', data => { const frame=JSON.parse(data); frames.push(frame); client.send(JSON.stringify({ headers: frame.headers, errcode: 0 })); });
  });
  const secrets=vault(), modelVault=vault(); await modelVault.set('default','fixture-model-key');
  const runtimeClient={ request: async (method,params={})=> {
    if(method==='wecom.config.get') return {ok:true,result:{config}};
    if(method==='wecom.config.save') { config={...params}; return {ok:true,result:{config}}; }
    if(method==='settings.get') return {ok:true,result:{activeSettingId:'default',settings:[{id:'default'}]}};
    if(method==='wecom.inbox.claim') { const claimed=!claims.has(params.msgid); claims.add(params.msgid); return {ok:true,result:{claimed}}; }
    if(method==='wecom.reply') { handled++; assert.equal(params.modelCredential.apiKey,'fixture-model-key'); return {ok:true,result:{text:'本人答复'}}; }
    return {ok:true,result:{}};
  }};
  const service=new WecomService({runtimeClient,vault:secrets,modelVault,clientFactory: options=> {
    assert.equal(options.wsUrl,'wss://openws.work.weixin.qq.com');
    return new WSClient({...options,wsUrl:'ws://127.0.0.1:'+server.address().port,reconnectInterval:30,heartbeatInterval:50});
  }});
  t.after(async()=>{await service.close(); for(const client of server.clients) client.terminate(); await new Promise(resolve=>server.close(resolve));});
  assert.equal((await service.handle('wecom.settings.save',{botId:'bot1',ownerId:'owner',secret:'fixture-wecom-secret'})).error.code,'wecom_owner_confirmation_required');
  const saved=await service.handle('wecom.settings.save',{botId:'bot1',ownerId:'owner',secret:'fixture-wecom-secret',confirmOwner:true});
  assert.equal(saved.ok,true); assert.equal(JSON.stringify(saved).includes('fixture-wecom-secret'),false);
  assert.equal((await service.handle('wecom.connect')).ok,true);
  await until(async()=> (await service.handle('wecom.status')).result.status==='connected');
  assert.equal(frames[0].cmd,'aibot_subscribe'); assert.equal(frames[0].body.secret,'fixture-wecom-secret');
  socket.send(JSON.stringify(message('group',{chattype:'group'})));
  socket.send(JSON.stringify(message('other',{from:{userid:'other'}})));
  socket.send(JSON.stringify(message('bot',{aibotid:'other'})));
  socket.send(JSON.stringify(message('owner')));
  await until(()=>frames.some(frame=>frame.cmd==='aibot_respond_msg'));
  assert.equal(handled,1);
  const sent=frames.find(frame=>frame.cmd==='aibot_respond_msg');
  assert.equal(sent.headers.req_id,'request-owner'); assert.equal(sent.body.stream.content,'本人答复'); assert.equal(sent.body.stream.finish,true);
  socket.terminate();
  await until(()=>connections===2);
  await until(async()=> (await service.handle('wecom.status')).result.status==='connected');
  socket.send(JSON.stringify(message('owner')));
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(handled,1);
  assert.equal((await service.handle('wecom.disconnect')).result.status,'disconnected');
});
test('renderer cannot invoke channel internals or change conversation storage key',async()=>{
  const calls=[];
  const handler=createRuntimeRequestHandler({ runtimeClient:{request:async(method,params)=> {calls.push({method,params}); return {ok:true,result:{activeSettingId:'default',settings:[{id:'default'}],servers:[]}};}},vault:{get:async()=> 'key'}});
  assert.equal((await handler({method:'wecom.reply',params:{}})).error.code,'runtime_method_forbidden');
  assert.equal((await handler({method:'wecom.config.get'})).error.code,'runtime_method_forbidden');
  await handler({method:'chat.send',params:{text:'消息',conversationKey:'wecom_conversation_forged'}});
  assert.equal(calls.find(call=>call.method==='chat.send').params.conversationKey,undefined);
});
