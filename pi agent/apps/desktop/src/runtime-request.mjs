import { randomUUID } from 'node:crypto';

export function createRuntimeRequestHandler({ runtimeClient, vault, searchVault, selectWorkspace, copyText, wecom }) {
  let modelRequestTail = Promise.resolve();

  async function internalMcpServers() {
    const result = await runtimeClient.request('mcp.servers.list_internal');
    return result.ok && Array.isArray(result.result?.servers) ? result.result.servers : [];
  }

  async function findMcpServer(id) {
    return (await internalMcpServers()).find((server) => server.id === id) ?? null;
  }

  async function publicMcpServer(server) {
    if (!server) return server;
    const { credentialRef, ...publicServer } = server;
    return { ...publicServer, hasBearerToken: credentialRef ? await vault.has(credentialRef) : false };
  }

  async function deleteUnusedModelCredential(credentialRef, configuration) {
    const settings = configuration?.ok ? configuration.result?.settings : null;
    if (credentialRef && Array.isArray(settings) && !settings.some((entry) => (entry.credentialRef ?? entry.id) === credentialRef)) {
      await vault.delete?.(credentialRef);
    }
  }

  async function handle(request) {
    const { method, params = {} } = request ?? {};
    if (['schedule.tick', 'schedule.run', 'maintenance.snapshot'].includes(method)) return { ok: false, error: { code: 'runtime_method_forbidden', message: '该方法仅由主进程调用。' } };
    if (typeof method === 'string' && method.startsWith('wecom.')) {
      if (!['wecom.settings.get', 'wecom.settings.save', 'wecom.status', 'wecom.connect', 'wecom.disconnect', 'wecom.history'].includes(method)) return { ok: false, error: { code: 'runtime_method_forbidden', message: '渠道内部方法不可由 Renderer 调用。' } };
      return wecom ? wecom.handle(method, params) : { ok: false, error: { code: 'wecom_unavailable', message: '企业微信服务不可用。' } };
    }
    if (method === 'clipboard.write') {
      if (typeof params.text !== 'string' || params.text.length > 65536) return { ok: false, error: { code: 'clipboard_text_invalid', message: '复制内容超过允许范围。' } };
      try {
        if (!copyText) throw Error('unavailable');
        await copyText(params.text);
        return { ok: true, result: { copied: true } };
      } catch { return { ok: false, error: { code: 'clipboard_unavailable', message: '无法写入系统剪贴板。' } }; }
    }
    if (method === 'workspace.authorize') return { ok: false, error: { code: 'workspace_authorization_denied', message: '工作区只能通过系统目录选择器授权' } };
    if (method === 'mcp.servers.list_internal') return { ok: false, error: { code: 'runtime_method_forbidden', message: 'MCP 内部凭据引用不能由 Renderer 读取' } };
    if (method === 'mcp.servers.list') {
      const result = await runtimeClient.request(method, params);
      if (!result.ok) return result;
      const internal = await internalMcpServers();
      const byId = new Map(internal.map((server) => [server.id, server]));
      result.result.servers = await Promise.all(result.result.servers.map((server) => publicMcpServer(byId.get(server.id) ?? server)));
      return result;
    }
    if (method === 'mcp.server.save') {
      const requestKeys = Object.keys(params ?? {});
      if (requestKeys.some((key) => !['server', 'bearerToken'].includes(key)) || !params.server ||
          (params.bearerToken !== undefined && (typeof params.bearerToken !== 'string' || params.bearerToken.length > 8192))) {
        return { ok: false, error: { code: 'mcp_server_invalid', message: 'MCP 服务设置无效' } };
      }
      const current = await findMcpServer(params.server.id);
      const previousRef = current?.credentialRef;
      const credentialRef = params.bearerToken ? randomUUID() : previousRef;
      const server = { ...params.server };
      delete server.credentialRef;
      if (credentialRef) server.credentialRef = credentialRef;
      if (params.bearerToken) await vault.set(credentialRef, params.bearerToken);
      let result;
      try {
        result = await runtimeClient.request(method, { server });
      } catch (error) {
        if (params.bearerToken) {
          try {
            const committed = await findMcpServer(server.id);
            if (committed?.credentialRef === credentialRef) {
              if (previousRef && previousRef !== credentialRef) await vault.delete?.(previousRef);
              return { ok: true, result: { server: await publicMcpServer(committed) } };
            }
            if (committed && committed.credentialRef !== previousRef) await vault.delete?.(credentialRef);
          } catch {
            // Retain encrypted credentials when Runtime cannot establish the saved state.
          }
        }
        throw error;
      }
      if (!result.ok) {
        if (params.bearerToken) await vault.delete?.(credentialRef);
        return result;
      }
      if (previousRef && previousRef !== credentialRef) await vault.delete?.(previousRef);
      result.result.server = await publicMcpServer(result.result.server);
      return result;
    }
    if (method === 'mcp.server.connect' || method === 'mcp.tool.call') {
      const serverId = method === 'mcp.server.connect' ? params.id : params.serverId;
      const server = await findMcpServer(serverId);
      if (!server) return { ok: false, error: { code: 'mcp_server_not_found', message: 'MCP 服务不存在' } };
      const token = server.credentialRef ? await vault.get(server.credentialRef) : null;
      const { mcpCredential: _rendererCredential, ...safeParams } = params ?? {};
      return runtimeClient.request(method, {
        ...safeParams,
        ...(token ? { mcpCredential: { token } } : {})
      });
    }
    if (method === 'mcp.server.remove') {
      const server = await findMcpServer(params.id);
      const result = await runtimeClient.request(method, params);
      if (result.ok && server?.credentialRef) await vault.delete?.(server.credentialRef);
      return result;
    }
    if (method === 'mcp.server.set_enabled' || method === 'mcp.tool.set_enabled') {
      return runtimeClient.request(method, params);
    }
    if (method === 'workspace.select') {
      if (typeof selectWorkspace !== 'function') return { ok: false, error: { code: 'workspace_selector_unavailable', message: '系统目录选择器不可用' } };
      return selectWorkspace();
    }
    if (method === 'settings.update') {
      const setting = { ...(params.setting ?? params) };
      const apiKey = setting.apiKey;
      delete setting.apiKey;
      const id = setting.id ?? 'default';
      const current = await runtimeClient.request('settings.get');
      if (!current.ok) return current;
      const previous = current.result.settings.find((entry) => entry.id === id);
      const previousCredentialRef = previous?.credentialRef ?? (await vault.has(id) ? id : undefined);
      delete setting.credentialRef;
      const credentialRef = apiKey ? randomUUID() : previousCredentialRef;
      if (credentialRef) setting.credentialRef = credentialRef;
      if (apiKey) await vault.set(credentialRef, apiKey);
      setting.hasApiKey = credentialRef ? await vault.has(credentialRef) : false;
      let result;
      let requestError;
      try {
        result = await runtimeClient.request(method, { setting });
      } catch (error) {
        requestError = error;
      }
      if (!result?.ok && apiKey) {
        const reconciled = await runtimeClient.request('settings.get').catch(() => null);
        const committedSetting = reconciled?.ok && reconciled.result.settings.find((entry) => entry.id === id && entry.credentialRef === credentialRef);
        if (committedSetting) {
          result = { ok: true, result: { setting: { ...committedSetting, hasApiKey: await vault.has(credentialRef) } } };
        } else {
          await deleteUnusedModelCredential(credentialRef, reconciled);
        }
      }
      if (!result?.ok && requestError) throw requestError;
      if (result.ok && previousCredentialRef && previousCredentialRef !== credentialRef) {
        const remaining = await runtimeClient.request('settings.get').catch(() => null);
        await deleteUnusedModelCredential(previousCredentialRef, remaining);
      }
      if (result.ok && result.result?.setting) delete result.result.setting.credentialRef;
      return result;
    }
    if (method === 'settings.remove') {
      if (params.confirm !== true || typeof params.id !== 'string' || !params.id) {
        return { ok: false, error: { code: 'model_confirmation_required', message: '请确认删除具体模型配置' } };
      }
      const before = await runtimeClient.request('settings.get');
      if (!before.ok) return before;
      const previous = before.result.settings.find((entry) => entry.id === params.id);
      if (!previous) return { ok: false, error: { code: 'model_configuration_missing', message: '模型配置不存在' } };
      const credentialRef = previous.credentialRef ?? previous.id;
      let result;
      let requestError;
      try {
        result = await runtimeClient.request(method, { id: params.id, confirm: true });
      } catch (error) {
        requestError = error;
      }
      const remaining = await runtimeClient.request('settings.get').catch(() => null);
      if (!result?.ok && remaining?.ok && !remaining.result.settings.some((entry) => entry.id === params.id)) {
        result = { ok: true, result: { removed: true, activeSettingId: remaining.result.activeSettingId ?? null } };
      }
      if (!result?.ok && requestError) throw requestError;
      if (result.ok) await deleteUnusedModelCredential(credentialRef, remaining);
      return result;
    }
    if (method === 'settings.get') {
      const result = await runtimeClient.request(method, params);
      if (result.ok) for (const setting of result.result.settings) {
        const credentialRef = setting.credentialRef ?? setting.id;
        setting.hasApiKey = await vault.has(credentialRef);
        delete setting.credentialRef;
      }
      return result;
    }
    if (method === 'settings.test') {
      const settings = await runtimeClient.request('settings.get');
      const selectedId = params.settingId ?? settings.result?.activeSettingId ?? 'default';
      const setting = settings.ok ? settings.result.settings.find((entry) => entry.id === selectedId) : null;
      const credentialRef = setting?.credentialRef ?? setting?.id;
      const apiKey = setting ? await vault.get(credentialRef) : null;
      if (!apiKey) return { ok: false, error: { code: 'model_api_key_missing', message: '请先保存 API Key' } };
      return runtimeClient.request(method, { ...params, settingId: setting.id, apiKey });
    }
    if (method === 'research.settings.get' || method === 'research.settings.save' || method === 'research.settings.remove') {
      try {
        if (method === 'research.settings.save') {
          const key = typeof params.apiKey === 'string' ? params.apiKey.trim() : '';
          if (!/^[\x21-\x7e]{1,256}$/.test(key)) return { ok: false, error: { code: 'research_key_invalid', message: '请输入有效的搜索服务 API Key。' } };
          await searchVault.set('brave', key);
        }
        if (method === 'research.settings.remove') {
          if (params.confirm !== true) return { ok: false, error: { code: 'research_key_confirmation_required', message: '请确认移除网页调研密钥。' } };
          await searchVault.delete('brave');
        }
        return { ok: true, result: { hasKey: await searchVault.has('brave') } };
      } catch {
        return { ok: false, error: { code: 'research_vault_unavailable', message: '无法访问本机的网页调研密钥。' } };
      }
    }
    if (method === 'agent_task.start' || method === 'agent_task.resume') {
      let selectedId = params.settingId;
      if (method === 'agent_task.resume') {
        const lookup = await runtimeClient.request('agent_task.get', { id: params.id });
        if (!lookup.ok) return lookup;
        if (!lookup.result.task) return { ok: false, error: { code: 'agent_task_not_found', message: '任务不存在。' } };
        selectedId = lookup.result.task.binding.settingId;
      }
      const settings = await runtimeClient.request('settings.get');
      if (!settings.ok) return settings;
      const setting = settings.result.settings.find((entry) => entry.id === (selectedId ?? settings.result.activeSettingId));
      if (!setting) return { ok: false, error: { code: 'model_configuration_missing', message: '任务模型配置不可用。' } };
      const apiKey = await vault.get(setting.credentialRef ?? setting.id);
      if (!apiKey) return { ok: false, error: { code: 'model_api_key_missing', message: '请先保存模型密钥。' } };
      const input = method === 'agent_task.start' ? { text: params.text, settingId: setting.id } : { id: params.id };
      return runtimeClient.request(method, { ...input, modelCredential: { apiKey } });
    }
    if (method === 'research.run') {
      let searchKey;
      try { searchKey = await searchVault.get('brave'); }
      catch { return { ok: false, error: { code: 'research_vault_unavailable', message: '无法解密本机的网页调研密钥。' } }; }
      if (!searchKey) return { ok: false, error: { code: 'research_key_missing', message: '请先在网页调研设置中保存 API Key。' } };
      const settings = await runtimeClient.request('settings.get');
      if (!settings.ok) return settings;
      const setting = settings.result.settings.find((entry) => entry.id === (params.settingId ?? settings.result.activeSettingId));
      if (!setting) return { ok: false, error: { code: 'model_configuration_missing', message: '请先保存模型配置。' } };
      const apiKey = await vault.get(setting.credentialRef ?? setting.id);
      if (!apiKey) return { ok: false, error: { code: 'model_api_key_missing', message: '请先在模型设置中保存 API Key。' } };
      return runtimeClient.request(method, { text: params.text, settingId: setting.id, searchCredential: { apiKey: searchKey }, modelCredential: { apiKey } });
    }
    if (method === 'chat.send' && !params.task) {
      const settings = await runtimeClient.request('settings.get');
      const selectedId = params.settingId ?? settings.result?.activeSettingId ?? 'default';
      const setting = settings.ok ? settings.result.settings.find((entry) => entry.id === selectedId) : null;
      const credentialRef = setting?.credentialRef ?? setting?.id;
      const apiKey = credentialRef ? await vault.get(credentialRef) : null;
      if (!apiKey) return { ok: false, error: { code: 'model_api_key_missing', message: '请先在模型设置中保存 API Key' } };
      const mcpServers = await internalMcpServers();
      const mcpCredentials = [];
      for (const server of mcpServers) {
        if (!server.enabled || !server.tools.some((tool) => tool.enabled) || !server.credentialRef) continue;
        const token = await vault.get(server.credentialRef);
        if (token) mcpCredentials.push({ serverId: server.id, token });
      }
      return runtimeClient.request(method, { ...params, conversationKey: undefined, settingId: setting.id, modelCredential: { apiKey }, mcpCredentials });
    }
    return runtimeClient.request(method, params);
  }

  return (request) => {
    const method = request?.method;
    const serialize = ['settings.update', 'settings.test', 'settings.activate', 'settings.remove', 'mcp.server.save', 'mcp.server.connect',
      'mcp.server.remove', 'mcp.server.set_enabled', 'mcp.tool.set_enabled', 'mcp.tool.call',
      'research.run', 'research.settings.save', 'research.settings.remove', 'agent_task.start', 'agent_task.resume'].includes(method) ||
      (method === 'chat.send' && !request?.params?.task);
    if (!serialize) return handle(request);
    const next = modelRequestTail.then(() => handle(request), () => handle(request));
    modelRequestTail = next.then(() => undefined, () => undefined);
    return next;
  };
}
