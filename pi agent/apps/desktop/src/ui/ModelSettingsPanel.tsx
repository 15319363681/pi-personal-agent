import { useEffect, useRef, useState } from 'react';

export type ModelProfile = {
  id: string;
  name?: string;
  provider: string;
  model: string;
  baseUrl: string;
  apiFormat?: string;
  supportsImages?: boolean;
  hasApiKey?: boolean;
  revision?: string;
};

type Configuration = { settings: ModelProfile[]; activeSettingId: string | null };
type Confirmation = { kind: 'discard'; nextId: string | null } | { kind: 'delete'; profile: ModelProfile };
type Props = { disabled: boolean; onStatusChange: (id: string | null, label: string, ready: boolean) => void };

function emptyProfile(id: string): ModelProfile {
  return { id, name: '', provider: 'openai-responses', model: '', baseUrl: '', supportsImages: false };
}

function fingerprint(profile: ModelProfile) {
  return JSON.stringify([profile.id, profile.revision, profile.provider, profile.model, profile.baseUrl, profile.apiFormat, profile.supportsImages, profile.hasApiKey]);
}

async function request(method: string, params = {}) {
  const result = await window.piAgent.request(method, params);
  if (!result.ok) throw Error([result.error?.message ?? '模型设置请求失败', result.error?.correlationId].filter(Boolean).join(' · '));
  return result.result;
}

export function ModelSettingsPanel({ disabled, onStatusChange }: Props) {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ModelProfile>(emptyProfile('default'));
  const [apiKey, setApiKey] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tested, setTested] = useState<Record<string, string>>({});
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const busyRef = useRef(false);
  const dirtyRef = useRef(false);
  const draftIdRef = useRef('default');
  const newDraftRef = useRef(false);
  const loadSequence = useRef(0);
  const configurationLoaded = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  const applyDraft = (profile: ModelProfile, isNew = false) => {
    draftIdRef.current = profile.id;
    dirtyRef.current = false;
    newDraftRef.current = isNew;
    setDraft(profile);
    setApiKey('');
    setDirty(false);
    setConfirmation(null);
  };

  const reload = async (preferredId?: string): Promise<Configuration | null> => {
    const sequence = ++loadSequence.current;
    try {
      const result: Configuration = await request('settings.get');
      if (sequence !== loadSequence.current) return null;
      const currentId = result.activeSettingId ?? result.settings.find((item) => item.id === 'default')?.id ?? result.settings[0]?.id ?? null;
      setProfiles(result.settings);
      setActiveId(currentId);
      if (preferredId !== undefined || (!dirtyRef.current && !newDraftRef.current)) {
        const selectedId = preferredId ?? (configurationLoaded.current ? draftIdRef.current : currentId);
        const selected = result.settings.find((item) => item.id === selectedId) ?? result.settings.find((item) => item.id === currentId);
        const nextDraft = selected ?? emptyProfile('default');
        if (preferredId !== undefined || !configurationLoaded.current || fingerprint(nextDraft) !== fingerprint(draftRef.current)) applyDraft(nextDraft);
      }
      configurationLoaded.current = true;
      return { ...result, activeSettingId: currentId };
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '模型配置读取失败');
      return null;
    } finally { setLoading(false); }
  };

  useEffect(() => {
    void reload();
    const timer = window.setInterval(() => { if (!busyRef.current) void reload(); }, 1500);
    return () => { window.clearInterval(timer); loadSequence.current += 1; };
  }, []);

  useEffect(() => {
    const active = profiles.find((item) => item.id === activeId);
    const ready = Boolean(active && tested[active.id] === fingerprint(active) && !(dirty && draft.id === active.id) && !busy);
    onStatusChange(active?.id ?? null, active ? active.name || active.model || active.id : '尚未配置模型', ready);
  }, [profiles, activeId, tested, dirty, draft.id, busy, onStatusChange]);

  useEffect(() => { if (confirmation) cancelRef.current?.focus(); }, [confirmation]);

  const edit = (value: Partial<ModelProfile>) => {
    dirtyRef.current = true;
    setDirty(true);
    setDraft((current) => ({ ...current, ...value }));
    setNotice('');
  };

  const choose = (id: string | null) => {
    if (id === null) {
      applyDraft(emptyProfile('profile-' + crypto.randomUUID()), true);
      window.setTimeout(() => nameRef.current?.focus(), 0);
    } else {
      const profile = profiles.find((item) => item.id === id);
      if (profile) applyDraft(profile);
    }
    setNotice('');
    setError('');
  };

  const select = (id: string | null) => {
    if (dirtyRef.current) setConfirmation({ kind: 'discard', nextId: id });
    else choose(id);
  };

  const operate = async (operation: () => Promise<void>) => {
    if (busyRef.current || disabled) return;
    busyRef.current = true;
    loadSequence.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    try { await operation(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '模型设置操作失败'); }
    finally { busyRef.current = false; setBusy(false); }
  };

  const save = () => operate(async () => {
    const { hasApiKey: _hasApiKey, revision: _revision, ...value } = draft;
    const result = await request('settings.update', { setting: { ...value, apiKey } });
    setTested((current) => { const next = { ...current }; delete next[draft.id]; return next; });
    applyDraft(result.setting);
    await reload(result.setting.id);
    setNotice('配置已安全保存，请测试连接');
  });

  const testConnection = () => operate(async () => {
    const expected = fingerprint(draft);
    const id = draft.id;
    setTested((current) => { const next = { ...current }; delete next[id]; return next; });
    const result = await request('settings.test', { settingId: id });
    const latest = await reload(id);
    const profile = latest?.settings.find((item) => item.id === id);
    if (!profile || fingerprint(profile) !== expected) throw Error('测试期间配置发生变化，请重新测试');
    setTested((current) => ({ ...current, [id]: expected }));
    setNotice('连接成功 · ' + (result.usage?.totalTokens ?? '用量未知') + ' tokens · 费用未知');
  });

  const activate = () => operate(async () => {
    await request('settings.activate', { id: draft.id });
    await reload(draft.id);
    setNotice('已设为当前对话模型');
  });

  const remove = () => operate(async () => {
    if (confirmation?.kind !== 'delete') return;
    const id = confirmation.profile.id;
    await request('settings.remove', { id, confirm: true });
    setTested((current) => { const next = { ...current }; delete next[id]; return next; });
    newDraftRef.current = false;
    dirtyRef.current = false;
    setDirty(false);
    setConfirmation(null);
    await reload('');
    setNotice('模型配置及对应本机凭据已删除');
  });

  const locked = busy || disabled || loading;
  const saved = profiles.find((item) => item.id === draft.id);
  const verified = saved && tested[saved.id] === fingerprint(saved) && !dirty;
  return <section className="panel settings-panel model-settings-panel" aria-label="模型配置管理" aria-busy={busy || loading}>
    <div className="panel-heading"><h2>模型设置</h2><span>{loading ? '读取中…' : profiles.length + ' 个配置'}</span></div>
    <div className="model-profile-picker">
      <label htmlFor="model-profile-select">编辑配置</label>
      <select id="model-profile-select" disabled={locked || Boolean(confirmation)} value={draft.id} onChange={(event) => select(event.target.value)}>
        {!saved && <option value={draft.id}>新配置</option>}
        {profiles.map((item) => <option key={item.id} value={item.id}>{item.name || item.model || item.id}{item.id === activeId ? ' · 当前' : ''}</option>)}
      </select>
      <button className="secondary" onClick={() => select(null)} disabled={locked || Boolean(confirmation)}>新增配置</button>
    </div>
    <fieldset disabled={locked || Boolean(confirmation)}>
      <label>配置名称<input ref={nameRef} value={draft.name ?? ''} maxLength={80} onChange={(event) => edit({ name: event.target.value })} placeholder="例如，日常对话" /></label>
      <label>Provider<select value={draft.provider} onChange={(event) => edit({ provider: event.target.value, apiFormat: event.target.value === 'openai-responses' ? 'responses' : 'chat-completions' })}><option value="openai-responses">Responses 兼容服务</option><option value="openai-compatible">Chat Completions 兼容服务</option></select></label>
      <label>Model<input value={draft.model} onChange={(event) => edit({ model: event.target.value })} /></label>
      <label>端点 Base URL<input value={draft.baseUrl ?? ''} onChange={(event) => edit({ baseUrl: event.target.value })} placeholder="https://api.example.com/v1" /></label>
      <label>API Key<input type="password" autoComplete="new-password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); edit({}); }} placeholder={draft.hasApiKey ? '已加密保存，留空保留当前 Key' : '仅在本机输入新 Key'} /></label>
      <label className="model-image-option"><input type="checkbox" checked={draft.supportsImages ?? false} onChange={(event) => edit({ supportsImages: event.target.checked })} />服务支持图片输入</label>
    </fieldset>
    <div className="settings-actions">
      <button className="secondary" onClick={save} disabled={locked || Boolean(confirmation) || !draft.model.trim() || !draft.baseUrl?.trim() || (!apiKey && !draft.hasApiKey)}>{busy ? '处理中…' : '保存配置'}</button>
      <button className="secondary" onClick={testConnection} disabled={locked || Boolean(confirmation) || dirty || !saved?.hasApiKey}>测试连接</button>
      <button className="secondary" onClick={activate} disabled={locked || Boolean(confirmation) || dirty || !saved || draft.id === activeId}>设为当前模型</button>
      <button className="secondary model-delete" onClick={() => saved && setConfirmation({ kind: 'delete', profile: saved })} disabled={locked || Boolean(confirmation) || !saved}>删除配置</button>
    </div>
    <p className="model-profile-state">{dirty ? '有未保存的修改' : verified ? '该配置连接已测试' : saved ? '该配置连接尚未测试' : '填写并保存新配置'}</p>
    {error && <p className="model-error" role="alert">{error}</p>}
    {notice && <p className="model-notice" role="status">{notice}</p>}
    {confirmation && <div className="model-confirmation" role="alertdialog" aria-modal="false" aria-labelledby="model-confirm-title" onKeyDown={(event) => { if (event.key === 'Escape' && !busy) setConfirmation(null); }}>
      <h3 id="model-confirm-title">{confirmation.kind === 'delete' ? '删除“' + (confirmation.profile.name || confirmation.profile.model) + '”？' : '放弃未保存的修改？'}</h3>
      <p>{confirmation.kind === 'delete' ? '确认后会删除该配置和对应的本机密钥。' : '切换配置会清空当前草稿和新输入的密钥。'}</p>
      <div className="settings-actions"><button ref={cancelRef} className="secondary" disabled={busy} onClick={() => setConfirmation(null)}>保留并返回</button><button disabled={busy} onClick={() => confirmation.kind === 'delete' ? void remove() : choose(confirmation.nextId)}>{confirmation.kind === 'delete' ? '确认删除' : '放弃并切换'}</button></div>
    </div>}
    <small>连接测试和对话会把提示词与 API Key 提交给配置的服务，可能产生费用。</small>
  </section>;
}
