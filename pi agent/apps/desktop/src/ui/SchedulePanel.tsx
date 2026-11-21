import { useEffect, useState } from 'react';
type Schedule = { id: string; revision: number; text: string; kind: string; dueAt: number; enabled: boolean; completed: boolean; intervalMs: number };
type Event = { id: string; text: string; dueAt: number; status: string; unread: boolean; missed: number; reasonCode?: string; taskId?: string };
const labels: Record<string, string> = { fired: '已提醒', started: '任务已启动', failed: '执行失败', interrupted: '执行中断', cancelled: '已取消', pending: '等待处理', executing: '正在处理' };
export function SchedulePanel() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [text, setText] = useState('');
  const [kind, setKind] = useState('reminder');
  const [when, setWhen] = useState('');
  const [interval, setInterval] = useState('0');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const refresh = async () => {
    const result = await window.piAgent.request('schedule.list');
    if (result.ok) { setSchedules(result.result.schedules); setEvents(result.result.events); }
  };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => { try { if (active) await refresh(); } catch { if (active) setFeedback('暂时无法加载提醒。'); } if (active) timer = setTimeout(() => void tick(), 3000); };
    void tick(); return () => { active = false; clearTimeout(timer); };
  }, []);
  const act = async (method: string, params: object) => {
    if (busy) return false;
    setBusy(true);
    try {
      const result = await window.piAgent.request(method, params);
      if (!result.ok) { setFeedback(result.error?.message ?? '计划操作失败。'); return false; }
      await refresh(); setFeedback('计划已更新。'); return true;
    } catch { setFeedback('连接失败，输入内容已保留。'); return false; }
    finally { setBusy(false); }
  };
  return <details className="panel schedule-panel">
    <summary>提醒与周期任务 <span>{events.filter(event => event.unread).length} 条未读</span></summary>
    <p className="panel-help">桌面运行期间计时。重新启动时合并遗漏的周期，任务使用创建时确认的模型和目录。</p>
    <form onSubmit={async event => { event.preventDefault(); if (await act('schedule.create', { kind, text, dueAt: new Date(when).getTime(), intervalMs: Number(interval), confirm: confirmed })) { setText(''); setConfirmed(false); } }}>
      <label>类型<select value={kind} onChange={event => { setKind(event.target.value); setConfirmed(false); }}><option value="reminder">提醒</option><option value="agent-task">Agent 任务</option></select></label>
      <label>{kind === 'reminder' ? '提醒内容' : '任务目标'}<textarea value={text} maxLength={2000} onChange={event => { setText(event.target.value); setConfirmed(false); }} /></label>
      <label>首次执行时间<input type="datetime-local" value={when} onChange={event => { setWhen(event.target.value); setConfirmed(false); }} /></label>
      <label>重复<select value={interval} onChange={event => { setInterval(event.target.value); setConfirmed(false); }}><option value="0">仅一次</option><option value="3600000">每小时</option><option value="86400000">每天</option><option value="604800000">每周</option></select></label>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />{kind === 'reminder' ? '确认内容与时间' : '确认自动执行并向当前模型发送目标、已审核记忆及读取的授权资料'}</label>
      <button disabled={busy || !confirmed || !text.trim() || !when}>创建计划</button>
    </form>
    <div role="status" className="panel-feedback">{feedback}</div>
    <div className="schedule-list">{schedules.map(schedule => <article key={schedule.id}><strong>{schedule.text}</strong><small>{new Date(schedule.dueAt).toLocaleString()} · {schedule.intervalMs ? '周期执行' : '单次执行'} · {schedule.completed ? '已触发' : schedule.enabled ? '已启用' : '已暂停'}</small><div className="panel-actions"><button className="secondary" disabled={busy || schedule.completed} onClick={() => void act('schedule.set_enabled', { id: schedule.id, revision: schedule.revision, enabled: !schedule.enabled })}>{schedule.enabled ? '暂停计划' : '启用计划'}</button><button className="secondary danger" disabled={busy} onClick={() => setDeleting(schedule.id)}>删除</button></div>{deleting === schedule.id && <div className="inline-confirm"><p>确认删除此计划？已启动的任务可在 Agent 任务中取消。</p><button disabled={busy} onClick={async () => { if (await act('schedule.delete', { id: schedule.id, revision: schedule.revision, confirm: true })) setDeleting(null); }}>确认删除</button><button className="secondary" onClick={() => setDeleting(null)}>保留</button></div>}</article>)}</div>
    <details className="reminder-history"><summary>提醒与执行记录</summary>{events.map(event => <article key={event.id}><strong>{event.text}</strong><small>{new Date(event.dueAt).toLocaleString()} · {labels[event.status] ?? event.status}{event.missed > 0 ? ' · 合并 ' + event.missed + ' 期遗漏' : ''}</small>{event.reasonCode && <p>失败原因 {event.reasonCode}</p>}{event.taskId && <p>任务 ID {event.taskId}</p>}{event.unread && <button className="secondary" disabled={busy} onClick={() => void act('schedule.read', { id: event.id })}>标记已读</button>}</article>)}</details>
  </details>;
}
