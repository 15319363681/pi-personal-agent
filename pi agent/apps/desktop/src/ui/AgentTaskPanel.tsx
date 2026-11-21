import { useEffect, useRef, useState } from 'react';
import { DocumentSources, type DocumentSource } from './DocumentSources';

type Status = 'running' | 'paused' | 'interrupted' | 'failed' | 'cancelled' | 'completed';
type Summary = { id: string; goal: string; status: Status; titles: string[]; completedSteps: number; reasonCode?: string };
type Detail = { id: string; status: Status; steps: { title: string }[]; results: { text: string; sources: DocumentSource[]; toolExecutions: { id: string; name: string; status: string }[] }[] };
const statusLabels: Record<Status, string> = { running: '运行中', paused: '已暂停', interrupted: '已中断', failed: '执行失败', cancelled: '已取消', completed: '已完成' };
const reasons: Record<string, string> = { agent_task_memory_changed: '审核记忆已变更，请创建新任务', agent_task_plan_invalid: '模型未生成有效的步骤', agent_task_model_changed: '模型配置已变更', agent_task_workspace_changed: '工作区授权已变更', agent_task_budget: '已达到执行上限', agent_task_timeout: '当前步骤超时，可继续重试', model_request_failed: '模型请求失败，可继续重试', model_timeout: '模型请求超时，可继续重试', agent_task_failed: '当前步骤执行失败' };

export function AgentTaskPanel({ refreshVersion }: { refreshVersion: number }) {
  const [tasks, setTasks] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [feedback, setFeedback] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [processing, setProcessing] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const list = await window.piAgent.request('agent_task.list');
        if (!active) return;
        if (!list.ok) throw new Error('任务列表不可用');
        setTasks(list.result.tasks);
        if (selected) {
          const response = await window.piAgent.request('agent_task.get', { id: selected });
          if (!active) return;
          if (!response.ok) throw new Error('任务详情不可用');
          setDetail(response.result.task);
        }
        setRefreshError('');
      } catch { if (active) setRefreshError('暂时无法刷新任务状态。'); }
      finally { if (active) timer = setTimeout(refresh, 1300); }
    }
    void refresh();
    return () => { active = false; clearTimeout(timer); };
  }, [selected, refreshVersion]);

  const control = async (id: string, action: 'pause' | 'resume' | 'cancel') => {
    if (inFlight.current) return;
    inFlight.current = true;
    setProcessing(true);
    setFeedback('');
    try {
      const result = await window.piAgent.request(`agent_task.${action}`, { id });
      if (!result.ok) { setFeedback(result.error?.message ?? '任务操作失败。'); return; }
      const status: Status = result.result.task.status;
      setTasks((items) => items.map((item) => item.id === id ? { ...item, status, reasonCode: result.result.task.reasonCode } : item));
      setFeedback(statusLabels[status]);
    } catch { setFeedback('无法连接桌面主进程。'); }
    finally { inFlight.current = false; setProcessing(false); }
  };

  const copy = async (text: string) => {
    try {
      const response = await window.piAgent.request('clipboard.write', { text });
      if (!response.ok) throw Error('copy failed');
      setFeedback('已复制报告');
    }
    catch { setFeedback('复制失败，可选中结果手动复制。'); }
  };

  return <section className="panel agent-task-panel" aria-labelledby="agent-tasks-title">
    <div className="panel-heading"><h2 id="agent-tasks-title">Agent 任务</h2><span>{tasks.length} 项</span></div>
    <div className="agent-task-content">
      {refreshError && <p role="status">{refreshError}</p>}
      {tasks.length === 0 && !refreshError && <p className="agent-task-empty">在发送区切换到「Agent 任务」，输入目标以开始。</p>}
      {tasks.map((task) => <article className="agent-task" key={task.id}>
        <div className="agent-task-title"><strong>{task.goal}</strong><span>{statusLabels[task.status]}</span></div>
        {task.titles.length > 0 ? <>
          <progress aria-label="已完成步骤" max={task.titles.length} value={task.completedSteps} />
          <small>{task.completedSteps} / {task.titles.length} 步{task.status === 'running' && task.titles[task.completedSteps] ? ` · ${task.titles[task.completedSteps]}` : ''}</small>
        </> : task.status === 'running' ? <small>正在规划步骤</small> : null}
        {task.reasonCode && reasons[task.reasonCode] && <small className="research-unverified">{reasons[task.reasonCode]}</small>}
        <div className="agent-task-actions">
          <button type="button" className="secondary" aria-expanded={selected === task.id} onClick={() => { setDetail(null); setSelected(selected === task.id ? null : task.id); }}>{selected === task.id ? '收起详情' : '查看详情'}</button>
          {task.status === 'running' && <button type="button" className="secondary" disabled={processing} onClick={() => void control(task.id, 'pause')}>暂停</button>}
          {['paused', 'interrupted', 'failed'].includes(task.status) && <button type="button" className="secondary" disabled={processing} onClick={() => void control(task.id, 'resume')}>继续</button>}
          {['running', 'paused', 'interrupted', 'failed'].includes(task.status) && <button type="button" className="secondary" disabled={processing} onClick={() => void control(task.id, 'cancel')}>取消任务</button>}
        </div>
        {selected === task.id && (detail?.id === task.id ? <div className="agent-task-detail">
          <ol>{detail.steps.map(({ title }, index) => {
            const result = detail.results[index];
            return <li key={index}><strong>{title}</strong> <small>{result ? '已完成' : task.status === 'running' && index === task.completedSteps ? '运行中' : '未完成'}</small>
              {result && <><p>{result.text}</p><DocumentSources sources={result.sources} />
                {result.toolExecutions.length > 0 && <ul aria-label="工具结果">{result.toolExecutions.map((execution) => <li key={execution.id}>{execution.name} · {execution.status === 'succeeded' ? '成功' : '失败'}</li>)}</ul>}
              </>}
            </li>;
          })}</ol>
          {detail.status === 'completed' && detail.results.length > 0 && <button type="button" className="secondary" onClick={() => void copy(detail.results.at(-1)!.text)}>复制报告</button>}
        </div> : <small>读取详情中…</small>)}
      </article>)}
      {feedback && <p role="status">{feedback}</p>}
    </div>
  </section>;
}
