import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { PluginPanel } from './PluginPanel';
import { ArtifactPanel } from './ArtifactPanel';
import { AgentTaskPanel } from './AgentTaskPanel';
import { MemoryPanel } from './MemoryPanel';
import { WecomPanel } from './WecomPanel';
import { SchedulePanel } from './SchedulePanel';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { DocumentSources, type DocumentSource } from './DocumentSources';
import { ResearchResults, ResearchSettings, type Research } from './ResearchPanel';

type Task = { id: string; status: string; goal: string; contract: any; permissionSnapshot?: any; artifact?: any; reasonCode?: string };
type ToolExecution = { id?: string; name: string; status: string; durationMs?: number; summary?: Record<string, unknown> };
type Message = { id: string; role: string; content: string; taskId?: string; modelErrorCode?: string; toolExecutions?: ToolExecution[]; sources?: DocumentSource[]; research?: Research };
type Workspace = { authorized: boolean; root: string | null };
type ProductSkill = { id: string; name: string; description: string; enabled: boolean };
type McpTool = { name: string; description?: string; enabled: boolean };
type McpServer = { id: string; name: string; url: string; enabled: boolean; hasBearerToken?: boolean; tools: McpTool[] };

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
  const [researchText, setResearchText] = useState('');
  const [goal, setGoal] = useState('整理工作区资料');
  const [workspace, setWorkspace] = useState('');
  const [recipient, setRecipient] = useState('');
  const [activeModel, setActiveModel] = useState<{ id: string | null; label: string }>({ id: null, label: '尚未配置模型' });
  const [busy, setBusy] = useState(false);
  const [modelReady, setModelReady] = useState(false);
  const [composerMode, setComposerMode] = useState<'chat' | 'research' | 'agent-task' | 'task'>('chat');
  const [agentTaskRefresh, setAgentTaskRefresh] = useState(0);
  const [agentGoal, setAgentGoal] = useState('');
  const [hasResearchKey, setHasResearchKey] = useState<boolean | null>(null);
  const [notice, setNotice] = useState('Runtime 初始化中…');
  const [logPath, setLogPath] = useState('');
  const [workspaceState, setWorkspaceState] = useState<Workspace>({ authorized: false, root: null });
  const [productSkills, setProductSkills] = useState<ProductSkill[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpId, setMcpId] = useState('');
  const [mcpName, setMcpName] = useState('');
  const [mcpUrl, setMcpUrl] = useState('');
  const [mcpToken, setMcpToken] = useState('');

  const refresh = async () => {
    try {
      const [taskResult, conversation, systemStatus, workspaceStatus, skillResult, mcpResult] = await Promise.all([
        window.piAgent.request('task.list'),
        window.piAgent.request('conversation.list'),
        window.piAgent.request('system.status'),
        window.piAgent.request('workspace.get'),
        window.piAgent.request('skills.list'),
        window.piAgent.request('mcp.servers.list')
      ]);
      if (taskResult.ok) {
        setTasks(taskResult.result.tasks);
        setOutbox(taskResult.result.outbox);
        if (taskResult.result.recoveryMode) setNotice('恢复模式：外部副作用冻结');
        else setNotice((current) => current === 'Runtime 初始化中…' ? 'Runtime 在线' : current);
      }
      if (conversation.ok) setMessages(conversation.result.messages);
      if (systemStatus.ok) setLogPath(systemStatus.result.logPath);
      if (workspaceStatus.ok) setWorkspaceState(workspaceStatus.result);
      if (skillResult.ok) setProductSkills(skillResult.result.skills);
      if (mcpResult?.ok) setMcpServers(mcpResult.result.servers);
    } catch (error) {
      setNotice(`Runtime 连接失败：${error instanceof Error ? error.message : '未知错误'}`);
    }
  };

  useEffect(() => { refresh(); const timer = window.setInterval(refresh, 1500); return () => window.clearInterval(timer); }, []);

  const onModelStatusChange = useCallback((id: string | null, label: string, ready: boolean) => {
    setActiveModel((current) => current.id === id && current.label === label ? current : { id, label });
    setModelReady(ready);
  }, []);

  useEffect(() => {
    let alive = true;
    window.piAgent.request('research.settings.get').then((result) => {
      if (alive && result.ok) setHasResearchKey(result.result.hasKey);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const openResearchSettings = () => {
    const panel = document.querySelector<HTMLDetailsElement>('#research-settings');
    if (!panel) return;
    panel.open = true;
    panel.querySelector('input')?.focus();
  };

  const pending = useMemo(() => tasks.filter((task) => task.status === 'approval_pending'), [tasks]);

  const draft = composerMode === 'research' ? researchText : composerMode === 'agent-task' ? agentGoal : text;
  const setDraft = composerMode === 'research' ? setResearchText : composerMode === 'agent-task' ? setAgentGoal : setText;

  const send = async () => {
    if (busy || !draft.trim()) return;
    setBusy(true);
    try {
      if (composerMode === 'agent-task') {
        const result = await window.piAgent.request('agent_task.start', { text: agentGoal.trim(), settingId: activeModel.id });
        if (!result.ok) { setNotice(result.error?.message ?? '无法启动 Agent 任务'); return; }
        setAgentGoal('');
        setAgentTaskRefresh((value) => value + 1);
        setNotice('Agent 任务已启动');
        return;
      }
      if (composerMode === 'research') {
        if (!modelReady || !hasResearchKey) return;
        const result = await window.piAgent.request('research.run', { text: researchText.trim(), settingId: activeModel.id });
        if (!result.ok) { setNotice(result.error?.message ?? '网页调研失败'); return; }
        setResearchText('');
        setNotice('调研结果已保存');
        await refresh();
        return;
      }
      if (composerMode === 'chat') {
        const result = await window.piAgent.request('chat.send', { text: text.trim(), settingId: activeModel.id });
        if (!result.ok) { setNotice(`${result.error?.message ?? '模型请求失败'}${result.error?.correlationId ? ` · ID ${result.error.correlationId}` : ''}`); return; }
        setText('');
        const usage = result.result.usage;
        setNotice(`模型回复成功 · ${usage?.totalTokens ?? '用量未知'} tokens · 费用${result.result.costStatus === 'known' ? '已知' : '未知'} · ID ${result.result.correlationId}`);
        await refresh();
        return;
      }
      const task = {
        goal: goal.trim() || text.trim(),
        inputs: { root: workspace.trim() || undefined },
        deliverables: [{ kind: 'file', path: 'report.md' }],
        acceptanceCriteria: [{ type: 'artifact_exists', path: 'report.md' }],
        allowedTools: ['workspace.read', 'workspace.write'],
        budget: { toolCalls: 10, modelCalls: 0, costCents: 0 }
      };
      const result = await window.piAgent.request('chat.send', { text: text || goal, task });
      if (!result.ok) { setNotice(`${result.error?.message ?? '创建任务提案失败'}${result.error?.correlationId ? ` · ID ${result.error.correlationId}` : ''}`); return; }
      setText('');
      setNotice('本地任务提案已创建，尚未由模型规划或执行');
      await refresh();
    } catch (error) {
      setNotice(`请求失败：${error instanceof Error ? error.message : 'Runtime 连接错误'}`);
    } finally { setBusy(false); }
  };

  const approve = async (task: Task) => {
    await window.piAgent.request('task.approve', { taskId: task.id, approval: { permissionMode: 'workspace-write', providerInstance: 'local-file', recipient: recipient || undefined } });
    await refresh();
  };

  const setSkillEnabled = async (skill: ProductSkill, enabled: boolean) => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('skills.set_enabled', { id: skill.id, enabled });
      if (!result.ok) {
        setNotice(`技能状态更新失败：${result.error?.message ?? 'Runtime 请求失败'}`);
        return;
      }
      setNotice(`${skill.name}已${enabled ? '启用' : '停用'}`);
      await refresh();
    } catch (error) {
      setNotice(`技能状态更新失败：${error instanceof Error ? error.message : 'Runtime 连接错误'}`);
    } finally { setBusy(false); }
  };

  const saveMcpServer = async () => {
    if (!mcpId.trim() || !mcpName.trim() || !mcpUrl.trim()) { setNotice('请填写 MCP 服务 ID、名称和 HTTPS 地址'); return; }
    setBusy(true);
    try {
      const params: any = { server: { id: mcpId.trim(), name: mcpName.trim(), url: mcpUrl.trim(), enabled: true } };
      if (mcpToken) params.bearerToken = mcpToken;
      const result = await window.piAgent.request('mcp.server.save', params);
      if (!result.ok) { setNotice(result.error?.message ?? 'MCP 服务保存失败'); return; }
      setMcpToken('');
      setNotice('MCP 服务已保存。新工具默认停用，请连接后逐项授权');
      await refresh();
    } catch (error) { setNotice(`MCP 服务保存失败：${error instanceof Error ? error.message : 'Runtime 连接错误'}`); }
    finally { setBusy(false); }
  };

  const connectMcpServer = async (server: McpServer) => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('mcp.server.connect', { id: server.id });
      if (!result.ok) { setNotice(result.error?.message ?? 'MCP 工具发现失败'); return; }
      setNotice(`已发现 ${result.result.tools.length} 个工具。请逐项确认授权`);
      await refresh();
    } catch (error) { setNotice(`MCP 连接失败：${error instanceof Error ? error.message : 'Runtime 连接错误'}`); }
    finally { setBusy(false); }
  };

  const setMcpServerEnabled = async (server: McpServer, enabled: boolean) => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('mcp.server.set_enabled', { id: server.id, enabled });
      if (!result.ok) { setNotice(result.error?.message ?? 'MCP 服务状态更新失败'); return; }
      setNotice(`MCP 服务已${enabled ? '启用' : '停用'}`);
      await refresh();
    } finally { setBusy(false); }
  };

  const setMcpToolEnabled = async (server: McpServer, tool: McpTool, enabled: boolean) => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('mcp.tool.set_enabled', { serverId: server.id, name: tool.name, enabled });
      if (!result.ok) { setNotice(result.error?.message ?? 'MCP 工具授权更新失败'); return; }
      setNotice(`工具 ${tool.name} 已${enabled ? '授权' : '撤销授权'}`);
      await refresh();
    } finally { setBusy(false); }
  };

  const editMcpServer = (server: McpServer) => {
    setMcpId(server.id);
    setMcpName(server.name);
    setMcpUrl(server.url);
    setMcpToken('');
  };

  const removeMcpServer = async (server: McpServer) => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('mcp.server.remove', { id: server.id });
      if (!result.ok) { setNotice(result.error?.message ?? 'MCP 服务删除失败'); return; }
      if (mcpId === server.id) { setMcpId(''); setMcpName(''); setMcpUrl(''); setMcpToken(''); }
      setNotice('MCP 服务及其本地凭据引用已删除');
      await refresh();
    } finally { setBusy(false); }
  };

  const selectWorkspace = async () => {
    setBusy(true);
    try {
      const result = await window.piAgent.request('workspace.select');
      if (!result.ok) { setNotice(result.error?.message ?? '工作区选择失败'); return; }
      if (result.result?.canceled) { setNotice('已取消工作区选择'); return; }
      setNotice('工作区已授权，Pi 现在可以按权限读取其中的文本内容');
      await refresh();
    } catch (error) { setNotice(`工作区选择失败：${error instanceof Error ? error.message : 'Runtime 连接错误'}`); }
    finally { setBusy(false); }
  };

  return <div className="app-shell">
    <header className="topbar"><div><div className="eyebrow">LOCAL RUNTIME</div><h1>Pi Personal Agent</h1><small className="log-path">本地诊断日志：{logPath || '读取中…'}</small></div><span className="status-dot" role="status">● {notice}</span></header>
    <main className="layout">
      <div className="work-area"><section className="conversation panel"><div className="panel-heading"><h2>对话与任务</h2><span>{activeModel.label} · {modelReady ? '连接已测试' : '连接未验证'} · {messages.length} 条消息</span></div><div className="messages">{messages.length === 0 ? <div className="empty">输入消息开始对话，也可以切换到「Agent 任务」，让助手分步骤完成目标。</div> : messages.map((message) => <div className={`message ${message.role}`} key={message.id}><span className="role">{message.role === 'user' ? '你' : message.research ? '网页调研' : message.taskId ? '任务提案' : '模型回复'}</span><p>{message.content}</p><DocumentSources sources={message.sources} />{message.research && <ResearchResults research={message.research} />}{message.modelErrorCode === 'legacy_history_unverified' && <small className="history-unverified">历史消息未验证</small>}{message.toolExecutions?.length ? <div className="tool-executions">{message.toolExecutions.map((execution) => <div className="tool-execution" key={execution.id ?? execution.name}><span>{execution.name}</span><b className={execution.status}>{execution.status === 'succeeded' ? '成功' : execution.status === 'failed' ? '失败' : '执行中'}</b>{execution.summary?.status === 'missing' && <small>目标不存在</small>}{execution.summary?.status === 'no_text' && <small>未提取到文本</small>}{typeof execution.summary?.entryCount === 'number' && <small>{execution.summary.entryCount} 项{execution.summary.truncated === true ? '（已截断）' : ''}</small>}{execution.summary?.status === 'ok' && typeof execution.summary?.size === 'number' && <small>{execution.summary.size} 字节</small>}{execution.durationMs !== undefined && <small>{execution.durationMs} ms</small>}</div>)}</div> : null}</div>)}</div><div className="composer">
        <div className="mode-switch" role="group" aria-label="发送模式">
          <button type="button" aria-pressed={composerMode === 'chat'} className={composerMode === 'chat' ? 'selected' : 'secondary'} onClick={() => setComposerMode('chat')} disabled={busy}>普通对话</button>
          <button type="button" aria-pressed={composerMode === 'research'} className={composerMode === 'research' ? 'selected' : 'secondary'} onClick={() => setComposerMode('research')} disabled={busy}>网页调研</button>
          <button type="button" aria-pressed={composerMode === 'agent-task'} className={composerMode === 'agent-task' ? 'selected' : 'secondary'} onClick={() => setComposerMode('agent-task')} disabled={busy}>Agent 任务</button>
          <button type="button" aria-pressed={composerMode === 'task'} className={composerMode === 'task' ? 'selected' : 'secondary'} onClick={() => setComposerMode('task')} disabled={busy}>本地任务提案</button>
        </div>
        {composerMode === 'research' && <p className="research-note" id="research-send-scope">本条查询将发送至 Brave Search。当前模型只收到本条查询和返回的网页摘要。</p>}
        {composerMode === 'research' && !hasResearchKey && <button type="button" className="secondary research-setup" onClick={openResearchSettings}>设置搜索密钥</button>}
        {composerMode === 'research' && hasResearchKey && !modelReady && <p className="research-note">请先在模型设置中测试当前模型。</p>}
        {composerMode === 'agent-task' && <p className="research-note agent-task-scope" id="agent-task-scope">任务目标和使用到的授权目录资料将发送给当前模型。{!modelReady && ' 请先测试模型连接。'}</p>}
        <textarea aria-label={composerMode === 'research' ? '公开网页查询' : composerMode === 'agent-task' ? '任务目标' : '输入消息'} aria-describedby={composerMode === 'research' ? 'research-send-scope' : composerMode === 'agent-task' ? 'agent-task-scope' : undefined}
          value={draft} onChange={(event) => setDraft(event.target.value)}
          placeholder={composerMode === 'chat' ? '发送内容将提交给所选模型…' : composerMode === 'research' ? '输入公开调研问题或关键词…' : composerMode === 'agent-task' ? '描述要完成的任务…' : '描述本地报告任务…'} />
        <button type="button" onClick={send} disabled={busy || !draft.trim() || (composerMode !== 'task' && !modelReady) || (composerMode === 'research' && !hasResearchKey)}>
          {busy ? '请求中…' : composerMode === 'chat' ? '发送消息' : composerMode === 'research' ? '开始调研' : composerMode === 'agent-task' ? '启动任务' : '创建本地任务提案'}
        </button>
      </div></section>
        <AgentTaskPanel refreshVersion={agentTaskRefresh} />
      <ArtifactPanel />
      </div>
      <aside className="sidebar">
        <section className="panel workspace-panel"><div className="panel-heading"><h2>工作区授权</h2><span className={workspaceState.authorized ? 'authorized' : 'unauthorized'}>{workspaceState.authorized ? '已授权' : '未授权'}</span></div><div className="workspace-content"><p>{workspaceState.root ?? '尚未选择本地目录'}</p><button className="secondary" onClick={selectWorkspace} disabled={busy}>{workspaceState.authorized ? '更换工作区' : '选择工作区'}</button></div></section>
        <section className="panel skills-panel"><div className="panel-heading"><h2>产品技能</h2></div>{productSkills.map((skill) => <article className="product-skill" key={skill.id}><div><strong>{skill.name}</strong><p>{skill.description}</p></div><button className={skill.enabled ? 'secondary selected' : 'secondary'} onClick={() => setSkillEnabled(skill, !skill.enabled)} disabled={busy}>{skill.enabled ? '已启用' : '启用'}</button></article>)}</section>
        <section className="panel mcp-panel"><div className="panel-heading"><h2>远程 MCP</h2><span>仅 HTTPS / 本机回环</span></div><div className="mcp-form"><label>服务 ID<input value={mcpId} onChange={(event) => setMcpId(event.target.value)} placeholder="例如 research" /></label><label>名称<input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="例如 Research MCP" /></label><label>Streamable HTTP 地址<input value={mcpUrl} onChange={(event) => setMcpUrl(event.target.value)} placeholder="https://example.com/mcp" /></label><label>Bearer Token<input type="password" autoComplete="new-password" value={mcpToken} onChange={(event) => setMcpToken(event.target.value)} placeholder="留空保留已保存 Token" /></label><button className="secondary" onClick={saveMcpServer} disabled={busy}>保存 MCP 服务</button></div><div className="mcp-list">{mcpServers.length === 0 ? <p className="empty-small">尚未配置远程 MCP 服务</p> : mcpServers.map((server) => <article className="mcp-server" key={server.id}><div className="mcp-server-heading"><div><strong>{server.name}</strong><small>{server.id} · {server.url}</small></div><span className={server.enabled ? 'authorized' : 'unauthorized'}>{server.enabled ? '已启用' : '已停用'}</span></div><div className="mcp-actions"><button className="secondary" onClick={() => editMcpServer(server)} disabled={busy}>编辑</button><button className="secondary" onClick={() => connectMcpServer(server)} disabled={busy}>连接/刷新</button><button className="secondary" onClick={() => setMcpServerEnabled(server, !server.enabled)} disabled={busy}>{server.enabled ? '停用服务' : '启用服务'}</button><button className="secondary danger" onClick={() => removeMcpServer(server)} disabled={busy}>删除</button></div><small className="mcp-credential">{server.hasBearerToken ? 'Bearer Token 已由主进程加密保存' : '未保存 Bearer Token'}</small><div className="mcp-tools">{server.tools.length === 0 ? <span className="empty-small">连接后发现工具</span> : server.tools.map((tool) => <div className="mcp-tool" key={tool.name}><div><strong>{tool.name}</strong>{tool.description && <small>{tool.description}</small>}</div><button className={tool.enabled ? 'secondary selected' : 'secondary'} onClick={() => setMcpToolEnabled(server, tool, !tool.enabled)} disabled={busy || !server.enabled}>{tool.enabled ? '已授权' : '授权工具'}</button></div>)}</div></article>)}</div></section>
        <MemoryPanel />
        <WecomPanel />
        <SchedulePanel />
        <PluginPanel />
        <section className="panel task-panel"><div className="panel-heading"><h2>任务</h2><span>{tasks.length}</span></div><label>任务目标<input value={goal} onChange={(event) => setGoal(event.target.value)} /></label><label>工作区目录<input value={workspace} onChange={(event) => setWorkspace(event.target.value)} placeholder="留空使用 Runtime 工作区" /></label><label>本地通知目录<input value={recipient} onChange={(event) => setRecipient(event.target.value)} placeholder="可选，例如 D:\\PiNotifications" /></label><div className="task-list">{tasks.map((task) => <article className="task" key={task.id}><div><strong>{task.goal}</strong><span className={`badge ${task.status}`}>{statusLabel[task.status] ?? task.status}</span></div>{task.reasonCode && <small>{task.reasonCode}</small>}{task.status === 'approval_pending' && <button className="secondary" onClick={() => approve(task)}>批准并后台执行</button>}{['paused', 'interrupted', 'needs_attention'].includes(task.status) && <button className="secondary" onClick={() => window.piAgent.request('task.resume', { taskId: task.id }).then(refresh)}>恢复任务</button>}</article>)}</div>{pending.length > 0 && <div className="approval-note">有 {pending.length} 个任务等待你的审核。</div>}</section>
        <ModelSettingsPanel disabled={busy} onStatusChange={onModelStatusChange} />
        <ResearchSettings disabled={busy} hasKey={hasResearchKey} onStatus={setHasResearchKey} />
        <section className="panel delivery-panel"><div className="panel-heading"><h2>投递记录</h2><span>{outbox.length}</span></div>{outbox.slice(-5).reverse().map((event) => <div className="delivery" key={event.id}><span>{event.kind}</span><b className={event.status}>{event.status}</b></div>)}</section>
      </aside>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
