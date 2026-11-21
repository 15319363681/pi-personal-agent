import { useCallback, useEffect, useRef, useState } from 'react';
import { DocumentSources, type DocumentSource } from './DocumentSources';

type Artifact = {
  id: string;
  path: string;
  sha256: string;
  status: string;
  reasonCode?: string;
  workspace: { root: string; dev: string; ino: string; birthtimeNs: string };
  sources: DocumentSource[];
  size?: number;
  content?: string;
};
type ArtifactDetail = Artifact & { content: string };
const labels: Record<string, string> = {
  pending: '等待确认', writing: '正在创建', created: '已创建', failed: '创建失败', needs_attention: '需核对文件'
};
const reasons: Record<string, string> = {
  workspace_file_exists: '目标文件已存在。请在对话中指定新的文件名，重新准备产物。',
  workspace_parent_missing: '目标文件夹不存在。请准备到已存在的文件夹。',
  artifact_workspace_changed: '授权目录已变化。请切回此产物所属的工作区后重新查看。',
  workspace_not_authorized: '请先选择并授权本地工作区。',
  artifact_result_unknown: '创建结果待核对。请检查目标文件与预览正文。',
  artifact_not_pending: '该产物的状态已变化，请查看最新状态。',
  artifact_content_changed: '产物内容校验失败，请重新准备文件。',
  recovery_mode: '恢复模式已冻结文件创建，请先核对诊断信息。'
};
const request = (method: string, params?: unknown) => window.piAgent.request(method, params);

export function ArtifactPanel() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<ArtifactDetail | null>(null);
  const [confirmedReview, setConfirmedReview] = useState('');
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const generation = useRef(0);
  const creating = useRef(false);
  const selectedButton = useRef<HTMLButtonElement | null>(null);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [list, workspace, tasks, item] = await Promise.all([
        request('artifacts.list'), request('workspace.get'), request('task.list'),
        selectedId ? request('artifacts.get', { id: selectedId }) : Promise.resolve(null)
      ]);
      if (current !== generation.current) return;
      if (!list.ok || !workspace.ok || !tasks.ok || (item && !item.ok)) {
        throw new Error(list.error?.code ?? workspace.error?.code ?? tasks.error?.code ?? item?.error?.code ?? 'artifact_list_failed');
      }
      setItems(list.result.artifacts);
      setWorkspaceRoot(workspace.result.authorized ? workspace.result.root : null);
      setRecoveryMode(tasks.result.recoveryMode);
      if (item) setDetail(item.result.artifact);
      setAvailable(true);
      setLoaded(true);
      setError('');
    } catch (cause) {
      if (current !== generation.current) return;
      setAvailable(false);
      setLoaded(true);
      setConfirmedReview('');
      setError(cause instanceof Error ? cause.message : 'runtime_unavailable');
    }
  }, [selectedId]);

  useEffect(() => {
    setDetail(null);
    setConfirmedReview('');
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [refresh]);

  const reviewIdentity = detail ? JSON.stringify([detail.id, detail.sha256, detail.workspace, detail.status, workspaceRoot, recoveryMode]) : '';
  useEffect(() => { setConfirmedReview(''); }, [reviewIdentity]);
  const canCreate = available && detail?.status === 'pending' && workspaceRoot === detail.workspace.root && !recoveryMode;
  const confirmed = Boolean(reviewIdentity) && confirmedReview === reviewIdentity;

  const create = async () => {
    if (!detail || !canCreate || !confirmed || creating.current) return;
    creating.current = true;
    setBusy(true);
    setConfirmedReview('');
    setNotice('正在创建文件…');
    try {
      const result = await request('artifacts.create', { id: detail.id, sha256: detail.sha256, confirm: true });
      if (!result.ok) {
        setNotice(reasons[result.error?.code] ?? '创建失败，请重试读取状态并核对诊断日志。');
        return;
      }
      setDetail(result.result.artifact);
      setNotice('文件已创建。可以在目标目录查看。');
    } catch {
      setNotice('连接中断，创建结果待核对。请刷新状态后检查目标文件。');
    } finally { await refresh(); creating.current = false; setBusy(false); }
  };

  const closePreview = () => {
    setSelectedId('');
    setDetail(null);
    setNotice('');
    selectedButton.current?.focus();
  };

  return <details className="panel artifact-panel">
    <summary className="panel-heading"><h2>文件产物</h2><span>{items.filter((item) => item.status === 'pending').length} 待确认 · {items.length} 个文件</span></summary>
    <div className="artifact-content" aria-busy={busy || !loaded}>
      {!loaded && <p role="status">正在读取文件产物…</p>}
      {error && <div className="artifact-error" role="alert"><p>文件产物读取失败 · {error}</p><button className="secondary" onClick={refresh} disabled={busy}>重试读取</button></div>}
      {loaded && items.length === 0 && !error && <p className="empty-small">在对话中描述要整理的资料和交付文件。准备好的文件会显示在这里，审核后即可创建。</p>}
      <div className="artifact-list">{items.map((item) => <button
        key={item.id} className={'secondary' + (selectedId === item.id ? ' selected' : '')}
        aria-pressed={selectedId === item.id} disabled={busy}
        ref={selectedId === item.id ? selectedButton : undefined}
        onClick={() => { setSelectedId(item.id); setConfirmedReview(''); setNotice(''); }}
      ><span>{item.path}</span><small>{labels[item.status] ?? item.status} · {item.size?.toLocaleString()} 字节</small></button>)}</div>
      {selectedId && !detail && <p role="status">正在读取预览…</p>}
      {detail && <section className="artifact-detail" aria-label="文件预览">
        <div className="artifact-detail-heading"><h3>{detail.path}</h3><button className="secondary" onClick={closePreview} disabled={busy}>关闭预览</button></div>
        <dl className="artifact-metadata"><div><dt>目标文件</dt><dd><code>{detail.workspace.root + '/' + detail.path}</code></dd></div><div><dt>状态</dt><dd>{labels[detail.status] ?? detail.status}</dd></div></dl>
        <pre className="artifact-preview" tabIndex={0} aria-label="文件正文">{detail.content}</pre>
        <DocumentSources sources={detail.sources} />
        {detail.reasonCode && <p className="artifact-warning" role="status">{reasons[detail.reasonCode] ?? detail.reasonCode}</p>}
        {detail.status === 'pending' && <div className="artifact-approval">
          {workspaceRoot !== detail.workspace.root && <p className="artifact-warning">请先选择此产物所属的工作区。</p>}
          {recoveryMode && <p className="artifact-warning">恢复模式已冻结文件创建。</p>}
          <label><input type="checkbox" checked={confirmed} disabled={busy || !canCreate}
            onChange={(event) => setConfirmedReview(event.target.checked ? reviewIdentity : '')} />我已核对目标路径和正文，允许创建这个文件</label>
          <button onClick={create} disabled={busy || !canCreate || !confirmed}>{busy ? '正在创建…' : '确认创建文件'}</button>
        </div>}
      </section>}
      {notice && <p className="artifact-notice" role="status">{notice}</p>}
    </div>
  </details>;
}
