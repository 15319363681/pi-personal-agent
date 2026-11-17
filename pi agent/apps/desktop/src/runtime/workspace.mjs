import { realpath, lstat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';

export class WorkspaceAdmission {
  constructor(root, mode) { this.root=root; this.mode=mode; }
  static async open(root, mode='read-only') { return new WorkspaceAdmission(await realpath(root), mode); }
  #path(path) { const target=resolve(this.root,path); const rel=relative(this.root,target); if (rel.startsWith('..') || isAbsolute(rel)) throw Error('workspace_escape'); return target; }
  async read(path) { const target=this.#path(path); try { const st=await lstat(target); if(st.isSymbolicLink()) throw Error('workspace_reparse'); return {status:'ok',data:await readFile(target)}; } catch (error) { if(error.code==='ENOENT') return {status:'missing'}; throw error; } }
  async write(path,data) { if(this.mode==='read-only') throw Error('read_only'); const target=this.#path(path); await mkdir(dirname(target),{recursive:true}); await writeFile(target,data); return target; }
}
