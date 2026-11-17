import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Task = { id: string; status: string; goal: string; contract: any; permissionSnapshot?: any; artifact?: any; reasonCode?: string };
type Message = { id: string; role: string; content: string; taskId?: string };
type Setting = { id?: string; provider: string; model: string; baseUrl?: string };

declare global { interface Window { piAgent: { request: (method: string, params?: any) => Promise<any> } } }

const statusLabel: Record<string, string> = {
  approval_pending: '待审批', queued: '排队中', running: '执行中', completed: '已完成',
  interrupted: '已中断', paused: '已暂停', needs_attention: '需处理', cancelled: '已取消', failed: '失败'
};

function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [outbox, setOutbox] = useState<any[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [goal, setGoal] = useState('整理工作区资料');
  const [workspace, setWorkspace] = useState('');
  const [recipient, setRecipient] = useState('');
  const [settings, setSettings] = useState<Setting>({ id: 'default', provider: 'fake', model: 'demo', baseUrl: '' });
  const [notice, setNotice] = useState('Runtime 初始化中…');

  const refresh = async () => {
    const [taskResult, conversation, settingResult] = await Promise.all([
      window.piAgent.request('task.list'),
      window.piAgent.request('conversation.list'),
      window.piAgent.request('settings.get')
    ]);
    if (taskResult.ok) { setTasks(taskResult.result.tasks); setOutbox(taskResult.result.outbox); setNotice(taskResult.result.recoveryMode ? '恢复模式：外部副作用冻结' : 'Runtime 在线'); }
    if (conversation.ok) setMessages(conversation.result.messages);
    if (settingResult.ok && settingResult.result.settings[0]) setSettings(settingResult.result.settings[0]);
  };

  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 1500); return () => window.clearInterval(timer); }, []);

  const pending = useMemo(() => tasks.filter((task) => task.status === 'approval_pending'), [tasks]);

  const send = async () => {
    if (!text.trim() && !goal.trim()) return;
    const task = {
      goal: goal.trim() || text.trim(),
      inputs: { root: workspace.trim() || undefined },
      deliverables: [{ kind: 'file', path: 'report.md' }],
      acceptanceCriteria: [{ type: 'artifact_exists', path: 'report.md' }],
      allowedTools: ['workspace.read', 'workspace.write'],
      budget: { toolCalls: 10, modelCalls: 0, costCents: 0 }
    };
    const result = await window.piAgent.request('chat.send', { text: text || goal, task });
    if (!result.ok) setNotice(result.error?.message ?? '创建任务失败');
    setText('');
    await refresh();
  };

  const approve = async (task: Task) => {
    await window.piAgent.request('task.approve', { taskId: task.id, approval: { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: recipient || undefined } });
    await refresh();
  };

  const saveSettings = async () => { await window.piAgent.request('settings.update', { setting: settings }); setNotice('模型配置已保存'); };

  return <div className="app-shell">
    <header className="topbar"><div><div className="eyebrow">LOCAL RUNTIME</div><h1>Pi Personal Agent</h1></div><span className="status-dot">● {notice}</span></header>
    <main className="layout">
      <section className="conversation panel"><div className="panel-heading"><h2>持续对话</h2><span>{messages.length} 条消息</span></div><div className="messages">{messages.length === 0 ? <div className="empty">告诉 Agent 你希望长期执行的事情。</div> : messages.map((message) => <div className={`message ${message.role}`} key={message.id}><span className="role">{message.role === 'user' ? '你' : 'Agent'}</span><p>{message.content}</p></div>)}</div><div className="composer"><textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="补充任务要求或直接描述目标…"/><button onClick={send}>创建任务提案</button></div></section>
      <aside className="sidebar">
        <section className="panel task-panel"><div className="panel-heading"><h2>任务</h2><span>{tasks.length}</span></div><label>任务目标<input value={goal} onChange={(event) => setGoal(event.target.value)} /></label><label>工作区目录<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="留空使用 Runtime 工作区" /></label><label>本地通知目录<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="可选，例如 D:\\PiNotifications" /></label><div className="task-list">{tasks.map((task) => <article className="task" key={task.id}><div><strong>{task.goal}</strong><span className={`badge ${task.status}`}>{statusLabel[task.status] ?? task.status}</span></div>{task.reasonCode && <small>{task.reasonCode}</small>}{task.status === 'approval_pending' && <button className="secondary" onClick={() => approve(task)}>批准并后台执行</button>}{['paused', 'interrupted', 'needs_attention'].includes(task.status) && <button className="secondary" onClick={() => window.piAgent.request('task.resume', { taskId: task.id }).then(refresh)}>恢复任务</button>}</article>)}</div>{pending.length > 0 && <div className="approval-note">有 {pending.length} 个任务等待你的审核。</div>}</section>
        <section className="panel settings-panel"><div className="panel-heading"><h2>模型设置</h2><span>本地保存</span></div><label>Provider<input value={settings.provider} onChange={(event) => setSettings({ ...settings, provider: event.target.value })} /></label><label>Model<input value={settings.model} onChange={(event) => setSettings({ ...settings, model: event.target.value })} /></label><label>Base URL<input value={settings.baseUrl ?? ''} onChange={(event) => setSettings({ ...settings, baseUrl: event.target.value })} /></label><button className="secondary" onClick={saveSettings}>保存配置</button></section>
        <section className="panel delivery-panel"><div className="panel-heading"><h2>投递记录</h2><span>{outbox.length}</span></div>{outbox.slice(-5).reverse().map((event) => <div className="delivery" key={event.id}><span>{event.kind}</span><b className={event.status}>{event.status}</b></div>)}</section>
      </aside>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
