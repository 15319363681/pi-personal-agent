import { useEffect, useRef, useState, type FormEvent } from 'react';

export type Research = {
  status: 'empty' | 'unverified' | 'summarized';
  claims: { text: string; status: 'snippet' | 'unverified'; sourceIds: string[] }[];
  sources: { id: string; url: string; title: string; domain: string }[];
};

export function ResearchResults({ research }: { research: Research }) {
  const [copyFeedback, setCopyFeedback] = useState('');
  const copy = async (id: string, url: string) => {
    try {
      const response = await window.piAgent.request('clipboard.write', { text: url });
      if (!response.ok) throw Error('copy failed');
      setCopyFeedback(`已复制 ${id} 的网址`);
    } catch { setCopyFeedback(`复制 ${id} 失败，可选中网址手动复制。`); }
  };
  return <div className="research-result">
    {research.claims.length > 0 && <ul className="research-claims" aria-label="调研结论">
      {research.claims.map((claim, index) => <li key={index}>
        <span className={claim.status === 'snippet' ? 'research-evidence' : 'research-unverified'}>
          {claim.status === 'snippet' ? `依据搜索摘要 · 原文未核对 · ${claim.sourceIds.join('、')}` : '无法核实'}
        </span>
        <p>{claim.text}</p>
      </li>)}
    </ul>}
    {research.sources.length > 0 && <details className="document-sources research-source-list">
      <summary>网页来源 · {research.sources.length} 项</summary>
      <ol>{research.sources.map(({ id, url, title, domain }) => <li key={id}>
        <strong>{id} · {title}</strong>
        <small>{domain}</small>
        <span className="research-source-url">{url}</span>
        <button type="button" className="secondary" onClick={() => void copy(id, url)} aria-label={`复制 ${id} 的网址`}>复制网址</button>
      </li>)}</ol>
      <small role="status">{copyFeedback}</small>
    </details>}
  </div>;
}

export function ResearchSettings({ disabled, hasKey, onStatus }: {
  disabled: boolean; hasKey: boolean | null; onStatus: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [processing, setProcessing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const inFlight = useRef(false);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const keyInput = useRef<HTMLInputElement>(null);

  useEffect(() => { if (confirmRemove) cancelButton.current?.focus(); }, [confirmRemove]);
  const cancelRemove = () => { setConfirmRemove(false); removeButton.current?.focus(); };
  const update = async (remove: boolean) => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setProcessing(true);
    setFeedback(undefined);
    try {
      const result = await (remove
        ? window.piAgent.request('research.settings.remove', { confirm: true })
        : window.piAgent.request('research.settings.save', { apiKey: draft }));
      if (!result.ok) { setFeedback({ text: result.error?.message ?? '密钥设置失败。', error: true }); return; }
      onStatus(result.result.hasKey);
      setDraft('');
      setConfirmRemove(false);
      setFeedback({ text: remove ? '已移除网页调研密钥。' : '网页调研密钥已加密保存。' });
    } catch { setFeedback({ text: '无法连接桌面主进程。', error: true }); }
    finally { inFlight.current = false; setProcessing(false); }
    if (remove) requestAnimationFrame(() => keyInput.current?.focus());
  };
  const save = (event: FormEvent) => { event.preventDefault(); if (draft.trim() && !confirmRemove) void update(false); };
  return <details className="panel artifact-panel research-settings" id="research-settings">
    <summary className="panel-heading"><h2>网页调研</h2><span>{hasKey === null ? '读取设置中' : hasKey ? '已保存密钥' : '待设置'}</span></summary>
    <form className="research-settings-body" onSubmit={save} aria-busy={processing}>
      <p>查询由 Brave Search 检索，摘要由当前模型整理。</p>
      <label htmlFor="research-api-key">Brave Search API Key</label>
      <input ref={keyInput} id="research-api-key" type="password" autoComplete="new-password" maxLength={256} value={draft}
        disabled={disabled || processing || confirmRemove} onChange={(event) => setDraft(event.target.value)} />
      <div className="settings-actions">
        <button type="submit" disabled={disabled || processing || confirmRemove || !draft.trim()}>保存密钥</button>
        {hasKey && <button ref={removeButton} type="button" className="secondary" aria-expanded={confirmRemove} onClick={() => setConfirmRemove(true)} disabled={disabled || processing}>移除密钥</button>}
      </div>
      {confirmRemove && <div className="research-confirm" role="group" aria-label="确认移除调研密钥" onKeyDown={(event) => {
        if (event.key === 'Escape' && !processing) { event.preventDefault(); cancelRemove(); }
      }}>
        <p>移除后需重新设置密钥才能发起调研。</p>
        <div className="settings-actions">
          <button ref={cancelButton} type="button" className="secondary" onClick={cancelRemove} disabled={processing}>取消</button>
          <button type="button" disabled={disabled || processing} onClick={() => void update(true)}>确认移除</button>
        </div>
      </div>}
      {feedback && <p className={feedback.error ? 'research-unverified' : 'research-evidence'} role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    </form>
  </details>;
}
