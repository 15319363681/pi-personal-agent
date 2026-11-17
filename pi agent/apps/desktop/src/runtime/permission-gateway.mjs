export class PermissionGateway {
  check(action, contract, context = {}) {
    const mode=contract?.permissionSnapshot?.mode ?? 'read-only';
    if(action==='workspace.read') return {allowed:mode!=='none',reason:'workspace_read'};
    if(action==='workspace.write') return {allowed:['workspace-write','full-access'].includes(mode),reason:mode};
    if(action==='notify.send') return {allowed:context.recipient===contract?.permissionSnapshot?.recipient,reason:'recipient_scope'};
    if(action==='delete') return {allowed:mode==='full-access',reason:'high_risk'};
    return {allowed:false,reason:'unknown_action'};
  }
}
