import { WorkspaceAdmission } from './workspace.mjs';
import { PermissionGateway } from './permission-gateway.mjs';
import { acceptArtifact } from './acceptance.mjs';
import { collectWorkspaceReport } from './worker.mjs';

export class TaskRunner {
  constructor(store) { this.store=store; this.gateway=new PermissionGateway(); }
  async run(id) {
    const task=this.store.getTask(id); if(!task) throw Error('task_not_found');
    if (['paused', 'cancelled'].includes(task.status)) return task;
    if(task.status === 'interrupted') this.store.transitionTask(id, 'queued', 'recovered');
    if(this.store.getTask(id)?.status === 'queued') this.store.transitionTask(id,'running');
    const current=this.store.getTask(id); const root=current.contract.inputs.root; const permission=this.gateway.check('workspace.write',{...current.contract,permissionSnapshot:current.permissionSnapshot},{}); if(!permission.allowed) { this.store.transitionTask(id,'needs_attention','workspace_write_not_approved'); throw Error('workspace_write_not_approved'); }
    try { const ws=await WorkspaceAdmission.open(root,'workspace-write');
      const report=await collectWorkspaceReport(ws,root,current.goal); const artifactPath=await ws.write(current.contract.deliverables?.[0]?.path ?? 'report.md',report); const evidence=await acceptArtifact(current,artifactPath); const latest=this.store.getTask(id); if (['paused','cancelled'].includes(latest.status)) return {...latest,...evidence,evidence}; const completed=this.store.completeTask(id,evidence); return {...completed,...evidence,evidence}; }
    catch(error) { try { this.store.transitionTask(id,'needs_attention',error.message); } catch {} throw error; }
  }
}
