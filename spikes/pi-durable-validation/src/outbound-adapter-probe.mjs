// Disposable Windows protocol probe. Never connects to a real provider endpoint.
export function createTelegramProbe({origin,token,recipient}) {
 const base=new URL(origin);if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||base.username||base.password||base.pathname!=='/'||base.search||base.hash)throw Error('loopback_only');
 if(!token||!/^[\w-]+$/.test(token)||!recipient)throw Error('invalid_config');
 let connected=false;
 const request=async(method,body={})=>{
  const response=await fetch(`${base.origin}/bot${token}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(3000)});
  const data=await response.json();return {response,data};
 };
 return {
  validateConfig:()=>({valid:true}),
  capabilities:()=>({outboundText:true,attachments:false,idempotency:false,lookupDelivery:false,publicCallback:false}),
  async connect(){const {response,data}=await request('getMe');if(!response.ok||!data.ok||!data.result?.is_bot)throw Error('authentication_failed');connected=true;},
  async disconnect(){connected=false;},
  async send({text,recipient:target}){
   if(!connected)throw Error('not_connected');if(target!==recipient)throw Error('recipient_scope');if(typeof text!=='string'||!text.length||text.length>4096)throw Error('invalid_text');
   try{
    const {response,data}=await request('sendMessage',{chat_id:recipient,text});
    if(response.status===401||response.status===403)return {status:'rejected'};
    if(response.status===429)return {status:'rate_limited',retryAfter:data.parameters?.retry_after};
    if(response.ok&&data.ok&&data.result?.message_id)return {status:'delivered',receipt:String(data.result.message_id)};
    return {status:'unknown'};
   }catch{return {status:'unknown'};}
  },
 };
}
