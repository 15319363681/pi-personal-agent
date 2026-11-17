import {test,expect} from 'vitest';
import http from 'node:http';
import {createTelegramProbe} from '../src/outbound-adapter-probe.mjs';
test('windows_loopback_outbound_configuration_receipt_disconnect_and_errors',async()=>{
 const calls:any[]=[];let mode='ok';
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({url:req.url,body:JSON.parse(body||'{}')});
  if(mode==='drop'){req.socket.destroy();return;}
  res.setHeader('Content-Type','application/json');res.statusCode=mode==='auth'?401:mode==='limit'?429:200;
  res.end(JSON.stringify(mode==='ok'?{ok:true,result:req.url?.endsWith('/getMe')?{id:7,is_bot:true}:{message_id:23}}:{ok:false,error_code:res.statusCode,parameters:{retry_after:3}}));
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as any).port;
 try{
  expect(()=>createTelegramProbe({origin:'https://api.telegram.org',token:'fake',recipient:'42'})).toThrow('loopback_only');
  const p=createTelegramProbe({origin:`http://127.0.0.1:${port}`,token:'fake-token',recipient:'42'});
  expect(p.validateConfig()).toEqual({valid:true});expect(p.capabilities()).toMatchObject({outboundText:true,idempotency:false,lookupDelivery:false});
  await expect(p.send({text:'test',recipient:'42'})).rejects.toThrow('not_connected');await p.connect();
  const count=calls.length;await expect(p.send({text:'changed',recipient:'43'})).rejects.toThrow('recipient_scope');expect(calls).toHaveLength(count);
  expect(await p.send({text:'approved fixture',recipient:'42'})).toMatchObject({status:'delivered',receipt:'23'});
  expect(calls.at(-1)).toEqual({url:'/botfake-token/sendMessage',body:{chat_id:'42',text:'approved fixture'}});
  for(const [value,status] of [['auth','rejected'],['limit','rate_limited'],['drop','unknown']]){
   mode=value;const before=calls.length;expect(await p.send({text:'error fixture',recipient:'42'})).toMatchObject({status});expect(calls).toHaveLength(before+1);
  }
  await p.disconnect();await expect(p.send({text:'after disconnect',recipient:'42'})).rejects.toThrow('not_connected');
 }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
});
