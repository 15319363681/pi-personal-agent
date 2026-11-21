import { useEffect, useState } from 'react';
type Settings = { botId: string; ownerId: string; hasSecret: boolean; status: string; reasonCode?: string };
type Message = { msgid: string; text: string; reply: string; status: string; createdAt: number };
const labels: Record<string, string> = { connected: '已连接', connecting: '连接中', disconnected: '已断开', reconnecting: '正在重连', error: '连接失败', processed: '已处理', delivered: '已收到回执', delivery_unknown: '投递结果未知', processing: '处理中', interrupted: '处理已中断', failed: '处理失败' };
export function WecomPanel() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [botId, setBotId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [secret, setSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const refresh = async (initial = false) => {
    const result = await window.piAgent.request('wecom.settings.get');
    if (result.ok) { setSettings(result.result); if (initial) { setBotId(result.result.botId); setOwnerId(result.result.ownerId); } }
    const history = await window.piAgent.request('wecom.history');
    if (history.ok) setMessages(history.result.messages);
  };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async (initial = false) => {
      try { if (active) await refresh(initial); } catch { if (active) setFeedback('暂时无法读取渠道状态。'); }
      if (active) timer = setTimeout(() => void tick(), 2500);
    };
    void tick(true);
    return () => { active = false; clearTimeout(timer); };
  }, []);
  const act = async (method: string, params = {}) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.piAgent.request(method, params);
      if (!result.ok) { setFeedback(result.error?.message ?? '渠道操作失败。'); return; }
      setSettings(result.result);
      if (method === 'wecom.settings.save') { setSecret(''); setConfirmed(false); }
      setFeedback(method === 'wecom.connect' ? '正在认证，请查看连接状态。' : '渠道设置已更新。');
      await refresh();
    } catch { setFeedback('连接失败，输入内容已保留。'); }
    finally { setBusy(false); }
  };
  return <details className="panel wecom-panel">
    <summary>企业微信 <span role="status">{labels[settings?.status ?? 'disconnected']}</span></summary>
    <p className="panel-help">智能机器人长连接接收本人单聊。桌面退出后连接关闭，使用当前模型、工作区和已审核记忆。</p>
    <form onSubmit={event => { event.preventDefault(); void act('wecom.settings.save', { botId, ownerId, secret: secret || undefined, confirmOwner: confirmed }); }}>
      <label>机器人 ID<input value={botId} maxLength={128} onChange={event => setBotId(event.target.value)} /></label>
      <label>本人 userid<input value={ownerId} maxLength={128} onChange={event => { setOwnerId(event.target.value); setConfirmed(false); }} /></label>
      <label>机器人 Secret<input type="password" autoComplete="new-password" value={secret} maxLength={4096} placeholder={settings?.hasSecret ? '已加密保存，留空保留' : '由企业管理员提供'} onChange={event => setSecret(event.target.value)} /></label>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认该 userid 属于我本人</label>
      <div className="panel-actions"><button disabled={busy || !confirmed || !botId.trim() || !ownerId.trim()}>保存配置</button><button type="button" className="secondary" disabled={busy || !settings?.hasSecret} onClick={() => void act('wecom.connect')}>{settings?.status === 'connected' ? '重新连接' : '连接'}</button><button type="button" className="secondary" disabled={busy || settings?.status === 'disconnected'} onClick={() => void act('wecom.disconnect')}>断开</button></div>
    </form>
    <div role="status" className="panel-feedback">{feedback}{settings?.reasonCode && <p>{settings.reasonCode === 'wecom_delivery_unknown' ? '回复回执超时，请先查看下方本地结果。' : '连接或处理遇到问题，请检查配置后重连。'}</p>}</div>
    <details className="channel-help"><summary>单聊任务操作</summary><p>/任务 目标 · 启动任务</p><p>/任务列表 · 查看任务</p><p>/任务 ID · 查看进度与结果</p><p>/暂停 ID · /继续 ID · /取消 ID</p></details>
    <details className="wecom-history"><summary>企业微信聊天记录 <span>{messages.length}</span></summary>{messages.length === 0 && <p className="empty-small">该本人账号尚无记录</p>}{messages.map(message => <article key={message.msgid}><small>{new Date(message.createdAt).toLocaleString()} · {labels[message.status] ?? message.status}</small><p>{message.text}</p><p>{message.reply}</p></article>)}</details>
  </details>;
}
