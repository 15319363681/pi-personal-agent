import { openDeliveryDb, sendDelivery } from './delivery-journal.mjs';
import { open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const path=process.argv[2];const dir=dirname(path);const db=openDeliveryDb(path);
await sendDelivery(db,join(dir,'journal'),{calls:0,async send({id}){
 this.calls++;const handle=await open(join(dir,'accepted'),'wx');
 try{await handle.writeFile(id);await handle.sync();}finally{await handle.close();}
 process.stdout.write('PROVIDER_ACCEPTED\n');setInterval(()=>{},1000);return new Promise(()=>{});
}});
