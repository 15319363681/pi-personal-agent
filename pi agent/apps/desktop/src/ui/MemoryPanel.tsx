import { useEffect, useRef, useState } from 'react';
type Memory = { id: string; revision: number; text: string; source: string; status: 'pending' | 'approved' };
export function MemoryPanel() {
  const [items, setItems] = useState<Memory[]>([]);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<Memory | null>(null);
  const [confirming, setConfirming] = useState<Memory | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const refresh = async () => {
    const result = await window.piAgent.request('memory.list');
    if (result.ok) setItems(result.result.memories);
    else setMessage(result.error?.message ?? '无法加载个人记忆。');
  };
  useEffect(() => { void refresh(); }, []);
  const act = async (method: string, params: object) => {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await window.piAgent.request(method, params);
      if (!result.ok) { setMessage(result.error?.message ?? '记忆操作失败。'); await refresh(); return false; }
      setMessage(method === 'memory.approve' ? '已批准，后续对话和任务可以使用。' : '记忆已更新。');
      await refresh();
      return true;
    } catch { setMessage('连接失败，内容已保留。'); return false; }
    finally { setBusy(false); }
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await act(editing ? 'memory.update' : 'memory.propose', { id: editing?.id, revision: editing?.revision, text: draft })) {
      setDraft(''); setEditing(null); editor.current?.focus();
    }
  };
  return <details className="panel memory-panel" onToggle={(event) => { if (event.currentTarget.open) void refresh(); }}>
    <summary>个人记忆 <span>{items.filter(item => item.status === 'pending').length} 项待审核</span></summary>
    <p className="panel-help">批准后，偏好会随桌面和企业微信的对话、任务发送给所选模型服务。</p>
    <form onSubmit={save}>
      <label>{editing ? '编辑记忆，保存后重新审核' : '添加待审核记忆'}<textarea ref={editor} value={draft} maxLength={2000} onChange={event => setDraft(event.target.value)} /></label>
      <div className="panel-actions"><button disabled={busy || !draft.trim()}>{editing ? '保存待审核版本' : '提交审核'}</button>{editing && <button type="button" className="secondary" onClick={() => { setEditing(null); setDraft(''); }}>取消编辑</button>}</div>
    </form>
    <div role="status" className="panel-feedback">{message}</div>
    <div className="memory-list">{items.length === 0 && <p className="empty-small">还没有个人记忆</p>}{items.map(item => <article className="memory-item" key={item.id + item.revision}>
      <div className="memory-heading"><strong>{item.status === 'pending' ? '待审核' : '已批准'}</strong><small>{({ user: '你添加或编辑', agent: '助手提议', legacy: '旧记录导入' })[item.source] ?? '旧记录'} · 版本 {item.revision}</small></div>
      <p>{item.text}</p><div className="panel-actions">
        {item.status === 'pending' && <><button disabled={busy} onClick={() => void act('memory.approve', item)}>批准此版本</button><button className="secondary" disabled={busy} onClick={() => void act('memory.reject', item)}>拒绝</button></>}
        <button className="secondary" disabled={busy} onClick={() => { setEditing(item); setDraft(item.text); editor.current?.focus(); }}>编辑</button>
        <button className="secondary danger" disabled={busy} onClick={() => setConfirming(item)}>删除</button>
      </div>
      {confirming?.id === item.id && confirming.revision === item.revision && <div className="inline-confirm" role="group" aria-label="确认删除记忆"><p>删除这条记忆的全部版本？后续请求将停止使用。</p><button className="danger" disabled={busy} onClick={async () => { if (await act('memory.delete', item)) setConfirming(null); }}>确认删除</button><button className="secondary" onClick={() => setConfirming(null)}>保留</button></div>}
    </article>)}</div>
  </details>;
}
