import {lstat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
// Refuse linked content before granting an AppContainer inherited workspace ACL.
// Otherwise a hardlink could cause the ACL grant to change an outside inode.
export async function checkWorkspace(root) {
 const s=await lstat(root);
 if(s.isSymbolicLink())throw Error('reparse_denied');
 if(s.isFile()&&s.nlink!==1)throw Error('hardlink_denied');
 if(s.isDirectory())for(const name of await readdir(root))await checkWorkspace(join(root,name));
}
