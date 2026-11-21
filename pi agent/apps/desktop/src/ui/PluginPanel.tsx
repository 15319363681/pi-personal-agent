import { useCallback, useEffect, useRef, useState } from 'react';

type PluginSummary = {
  id: string;
  name: string;
  description: string;
  version: number;
  enabled: boolean;
  testStatus: string;
  hash: string;
};
type PluginDetail = PluginSummary & {
  definition: { source: string; inputSchema: unknown; tests: unknown[] };
  versions: { version: number; hash: string; createdAt: number }[];
  tests: { id: string; version: number; status: string; createdAt: number; durationMs: number; cases: { name: string; status: string; errorCode?: string }[] }[];
};

const testLabels: Record<string, string> = { passed: '测试通过', failed: '测试失败', untested: '尚未测试' };
const request = (method: string, params?: unknown) => window.piAgent.request(method, params);

export function PluginPanel() {
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [detail, setDetail] = useState<PluginDetail | null>(null);
  const [confirmedReview, setConfirmedReview] = useState('');
  const [deleteReview, setDeleteReview] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const [list, item] = await Promise.all([
        request('plugins.list'),
        selectedId ? request('plugins.get', { id: selectedId }) : Promise.resolve(null)
      ]);
      if (current !== generation.current) return;
      if (!list.ok) throw new Error(list.error?.code ?? 'plugin_list_failed');
      setPlugins(list.result.plugins);
      if (item?.ok) setDetail(item.result.plugin);
      else if (item) { setDetail(null); setSelectedId(''); }
    } catch (error) {
      if (current === generation.current) setNotice(error instanceof Error ? error.message : '插件读取失败');
    }
  }, [selectedId]);

  useEffect(() => {
    setDetail(null);
    void refresh();
    const timer = window.setInterval(refresh, 1500);
    return () => { window.clearInterval(timer); generation.current++; };
  }, [refresh]);

  const reviewIdentity = detail ? detail.id + '/' + detail.version + '/' + detail.hash + '/' + detail.testStatus : '';
  const confirmed = confirmedReview === reviewIdentity && reviewIdentity !== '';
  const deleteRequested = deleteReview === reviewIdentity && reviewIdentity !== '';
  useEffect(() => { setConfirmedReview(''); setDeleteReview(''); }, [reviewIdentity]);

  const act = async (method: string, params: unknown, success: string) => {
    setBusy(true);
    setNotice('');
    setConfirmedReview('');
    setDeleteReview('');
    try {
      const result = await request(method, params);
      if (!result.ok) { setNotice(result.error?.code ?? '插件操作失败'); return; }
      if (method === 'plugins.test') setNotice(testLabels[result.result.test.status] ?? result.result.test.status);
      else setNotice(success);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Runtime 连接失败');
    } finally { await refresh(); setBusy(false); }
  };

  return <section className="panel plugin-panel" aria-label="本地插件">
    <div className="panel-heading"><h2>本地插件</h2><span>{plugins.length}</span></div>
    <div className="plugin-content">
      <p className="plugin-help">在对话中让 Agent 创建或更新插件。审核源码和样例，测试通过后确认当前版本。</p>
      {notice && <p role="status">{notice}</p>}
      {plugins.length === 0 && <p className="empty-small">尚无插件。可以让 Agent 创建一个文本统计插件并测试。</p>}
      <div className="plugin-list">{plugins.map((plugin) => <button
        key={plugin.id} className={selectedId === plugin.id ? 'secondary selected' : 'secondary'}
        onClick={() => { setSelectedId(plugin.id); setNotice(''); }} disabled={busy}>
        <strong>{plugin.name} · v{plugin.version}</strong>
        <small>{plugin.enabled ? '已启用' : '已停用'} · {testLabels[plugin.testStatus] ?? plugin.testStatus}</small>
      </button>)}</div>
      {detail && <article className="plugin-detail">
        <h3>{detail.name} · v{detail.version}</h3>
        <p>{detail.description}</p>
        <small className="plugin-hash">SHA-256 {detail.hash}</small>
        <details open><summary>当前源码</summary><pre>{detail.definition.source}</pre></details>
        <details><summary>输入 JSON Schema</summary><pre>{JSON.stringify(detail.definition.inputSchema, null, 2)}</pre></details>
        <details><summary>测试样例</summary><pre>{JSON.stringify(detail.definition.tests, null, 2)}</pre></details>
        <div className="plugin-actions">
          <button className="secondary" disabled={busy} onClick={() => act('plugins.test', { id: detail.id, version: detail.version }, '')}>{busy ? '操作中…' : '运行隔离测试'}</button>
          {detail.enabled && <button className="secondary" disabled={busy} onClick={() => act('plugins.set_enabled', { id: detail.id, version: detail.version, enabled: false }, '插件已停用')}>停用插件</button>}
        </div>
        {!detail.enabled && <div className="plugin-approval">
          <label><input type="checkbox" checked={confirmed} disabled={busy || detail.testStatus !== 'passed'} onChange={(event) => setConfirmedReview(event.target.checked ? reviewIdentity : '')} />
            我已审核 v{detail.version} 的源码、Schema 和样例，确认允许 Agent 调用此版本
          </label>
          <button disabled={busy || !confirmed || detail.testStatus !== 'passed'} onClick={() => act('plugins.set_enabled', { id: detail.id, version: detail.version, enabled: true, confirm: true }, '当前版本已确认启用')}>确认启用 v{detail.version}</button>
        </div>}
        <details><summary>本地测试记录 · {detail.tests.length}</summary>{detail.tests.map((record) => <div className="plugin-test" key={record.id}>
          <strong>v{record.version} · {testLabels[record.status] ?? record.status} · {record.durationMs} ms</strong>
          <time>{new Date(record.createdAt).toLocaleString()}</time>
          {record.cases.map((item, index) => <p key={index}>{item.name} · {testLabels[item.status] ?? item.status}{item.errorCode ? ' · ' + item.errorCode : ''}</p>)}
        </div>)}</details>
        <details><summary>版本记录 · {detail.versions.length}</summary>{detail.versions.map((item) => <p key={item.version}>v{item.version} · {new Date(item.createdAt).toLocaleString()}</p>)}</details>
        <button className="secondary danger" disabled={busy} onClick={() => setDeleteReview(reviewIdentity)}>删除插件</button>
        {deleteRequested && <div role="alertdialog" aria-label="确认删除插件" className="plugin-delete">
          <p>确认删除 {detail.name} v{detail.version}？删除后立即停止提供工具，历史版本和测试记录保存在本机。</p>
          <div className="plugin-actions"><button className="secondary danger" disabled={busy} onClick={() => act('plugins.remove', { id: detail.id, version: detail.version }, '插件已删除')}>确认删除</button><button className="secondary" disabled={busy} onClick={() => setDeleteReview('')}>取消</button></div>
        </div>}
      </article>}
    </div>
  </section>;
}
