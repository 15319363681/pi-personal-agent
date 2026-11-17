import {test,expect} from 'vitest';
import {createJob,closeHandle,objectSecurity,currentUserSid,privateJobName} from '../src/win32-process.mjs';
test('job_is_user_scoped_non_inheritable_and_rejects_second_handle_owner',()=>{
 const sid=currentUserSid();const name=privateJobName(`test:${process.pid}:${Date.now()}`);let h:any;
 try{
  expect(name).toContain(sid);h=createJob(name);const security=objectSecurity(h);
  expect(security.inheritable).toBe(false);expect(security.dacl).toContain(sid);
  expect(security.dacl).not.toContain(';;;WD');expect(security.dacl).not.toContain(';;;AU');
  expect(()=>createJob(name)).toThrow('job_already_owned');
 }finally{if(h)closeHandle(h);}
});
