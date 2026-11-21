import { randomUUID } from 'node:crypto';
import { WSClient } from '@wecom/aibot-node-sdk';
const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };
const fail = (code, message) => Object.assign(new Error(message), { code });

export class WecomService {
  constructor({ runtimeClient, vault, modelVault, clientFactory = options => new WSClient(options) }) {
    this.runtime = runtimeClient;
    this.vault = vault;
    this.modelVault = modelVault;
    this.clientFactory = clientFactory;
    this.client = null;
    this.generation = 0;
    this.state = { status: 'disconnected', reasonCode: null };
    this.tail = Promise.resolve();
    this.controlTail = Promise.resolve();
    this.queued = 0;
  }
  async #config() {
    const result = await this.runtime.request('wecom.config.get');
    if (!result.ok) throw fail('wecom_config_unavailable', '渠道配置不可用。');
    return result.result.config;
  }
  async #settings() {
    const config = await this.#config();
    return { botId: config?.botId ?? '', ownerId: config?.ownerId ?? '', hasSecret: Boolean(config?.credentialRef && await this.vault.has(config.credentialRef)), ...this.state };
  }
  handle(method, params = {}) {
    const job = this.controlTail.then(async () => {
      try {
        if (method === 'wecom.settings.get' || method === 'wecom.status') return { ok: true, result: await this.#settings() };
        if (method === 'wecom.history') return this.runtime.request(method);
        if (method === 'wecom.settings.save') {
          const current = await this.#config();
          if (params.confirmOwner !== true) throw fail('wecom_owner_confirmation_required', '请确认该 userid 属于你本人。');
          if (params.secret !== undefined && (typeof params.secret !== 'string' || params.secret.length > 4096)) throw fail('wecom_secret_invalid', '机器人密钥无效。');
          const credentialRef = params.secret ? randomUUID() : current?.credentialRef;
          if (!credentialRef) throw fail('wecom_secret_required', '请填写机器人密钥。');
          if (!params.secret && current && current.botId !== params.botId) throw fail('wecom_secret_required', '更换机器人时请重新填写密钥。');
          this.disconnect();
          await this.tail;
          if (params.secret) await this.vault.set(credentialRef, params.secret);
          const saved = await this.runtime.request('wecom.config.save', { botId: params.botId, ownerId: params.ownerId, credentialRef });
          if (!saved.ok) { if (params.secret) await this.vault.delete(credentialRef); return saved; }
          if (current?.credentialRef && current.credentialRef !== credentialRef) await this.vault.delete(current.credentialRef);
          return { ok: true, result: await this.#settings() };
        }
        if (method === 'wecom.connect') {
          const config = await this.#config();
          const secret = config?.credentialRef ? await this.vault.get(config.credentialRef) : null;
          if (!secret) throw fail('wecom_secret_required', '请先保存企业微信配置和密钥。');
          this.disconnect();
          const generation = this.generation;
          const client = this.clientFactory({ botId: config.botId, secret, wsUrl: 'wss://openws.work.weixin.qq.com', maxReconnectAttempts: -1, maxAuthFailureAttempts: 3, requestTimeout: 10000, maxReplyQueueSize: 20, logger: quietLogger });
          this.client = client;
          const state = (status, reasonCode = null) => { if (generation === this.generation) this.state = { status, reasonCode }; };
          client.on('authenticated', () => state('connected'));
          client.on('disconnected', () => state('disconnected', 'wecom_connection_closed'));
          client.on('reconnecting', () => state('reconnecting'));
          client.on('error', () => state('error', 'wecom_connection_error'));
          client.on('message.text', frame => this.#receive(frame, config, client, generation));
          state('connecting');
          client.connect();
          return { ok: true, result: await this.#settings() };
        }
        if (method === 'wecom.disconnect') { this.disconnect(); return { ok: true, result: await this.#settings() }; }
        throw fail('runtime_method_forbidden', '该渠道方法不可由桌面调用。');
      } catch (error) { return { ok: false, error: { code: error.code ?? 'wecom_unavailable', message: error.code ? error.message : '渠道操作失败，请检查配置后重试。' } }; }
    });
    this.controlTail = job.then(() => undefined, () => undefined);
    return job;
  }
  disconnect() {
    this.generation++;
    this.client?.disconnect();
    this.client = null;
    this.state = { status: 'disconnected', reasonCode: null };
  }
  #receive(frame, config, client, generation) {
    const body = frame?.body;
    if (generation !== this.generation || body?.chattype !== 'single' || body?.aibotid !== config.botId || body?.from?.userid !== config.ownerId || body?.msgtype !== 'text' || typeof frame.headers?.req_id !== 'string' || typeof body?.msgid !== 'string' || typeof body?.text?.content !== 'string' || !body.text.content.trim() || body.text.content.length > 4000) return;
    if (this.queued >= 10) { this.state = { ...this.state, reasonCode: 'wecom_queue_full' }; return; }
    this.queued++;
    const work = async () => {
      if (generation !== this.generation) return;
      const message = { msgid: body.msgid, text: body.text.content, revision: config.revision };
      const claim = await this.runtime.request('wecom.inbox.claim', message);
      if (!claim.ok || !claim.result.claimed) return;
      let response;
      try {
        const settings = await this.runtime.request('settings.get');
        const setting = settings.result?.settings?.find(item => item.id === settings.result.activeSettingId);
        const apiKey = setting ? await this.modelVault.get(setting.credentialRef ?? setting.id) : null;
        if (!apiKey) throw fail('model_api_key_missing', '请在桌面配置模型密钥。');
        response = await this.runtime.request('wecom.reply', { ...message, modelCredential: { apiKey } });
      } catch { response = { ok: false }; }
      if (!response.ok || generation !== this.generation) await this.runtime.request('wecom.inbox.fail', message);
      const text = response.ok ? response.result.text : '处理失败。请在桌面检查模型配置和任务状态后重新发送。';
      if (generation !== this.generation) return;
      let status = 'delivered';
      try { await client.replyStream(frame, randomUUID(), text.slice(0, 16000), true); }
      catch { status = 'delivery_unknown'; this.state = { ...this.state, reasonCode: 'wecom_delivery_unknown' }; }
      await this.runtime.request('wecom.inbox.delivery', { msgid: message.msgid, revision: config.revision, status });
    };
    this.tail = this.tail.then(work, work).catch(() => { this.state = { ...this.state, reasonCode: 'wecom_message_failed' }; }).finally(() => this.queued--);
  }
  async close() { this.disconnect(); await this.tail; }
}
