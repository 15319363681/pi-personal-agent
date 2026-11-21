import { createHash, randomUUID } from 'node:crypto';
const fail = (code, message) => Object.assign(new Error(message), { code });
export class WecomInbox {
  constructor(store) {
    this.store = store;
    store.db.exec(`CREATE TABLE IF NOT EXISTS wecom_inbox(namespace TEXT NOT NULL,msgid TEXT NOT NULL,text TEXT NOT NULL,reply TEXT NOT NULL DEFAULT '',status TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(namespace,msgid));`);
    store.db.prepare("UPDATE wecom_inbox SET status='interrupted' WHERE status='processing'").run();
  }
  config() { return JSON.parse(this.store.getMeta('wecom_config_v1') ?? 'null'); }
  save(input) {
    for (const key of ['botId', 'ownerId', 'credentialRef']) {
      if (typeof input[key] !== 'string' || !/^[a-zA-Z0-9_@.-]{1,128}$/.test(input[key])) throw fail('wecom_config_invalid', '请填写有效的机器人 ID、本人 userid 和密钥。');
    }
    const config = { botId: input.botId, ownerId: input.ownerId, credentialRef: input.credentialRef, revision: randomUUID() };
    this.store.setMeta('wecom_config_v1', JSON.stringify(config));
    return config;
  }
  namespace() {
    const config = this.config();
    if (!config) throw fail('wecom_config_required', '请先保存企业微信配置。');
    return createHash('sha256').update(JSON.stringify([config.botId, config.ownerId])).digest('hex');
  }
  conversationKey() { return 'wecom_conversation_' + this.namespace(); }
  assertRevision(revision) {
    if (revision !== undefined && this.config()?.revision !== revision) throw fail('wecom_config_changed', '渠道配置已变更。');
  }
  claim({ msgid, text, revision }) {
    this.assertRevision(revision);
    if (typeof msgid !== 'string' || !msgid || msgid.length > 256 || typeof text !== 'string' || !text.trim() || text.length > 4000) throw fail('wecom_message_invalid', '消息内容超过允许范围。');
    const changed = this.store.db.prepare("INSERT OR IGNORE INTO wecom_inbox(namespace,msgid,text,status,created_at) VALUES (?,?,?,'processing',?)").run(this.namespace(), msgid, text, Date.now());
    return { claimed: changed.changes === 1 };
  }
  finish(msgid, reply, status = 'processed', namespace = this.namespace()) {
    this.store.db.prepare('UPDATE wecom_inbox SET reply=?,status=? WHERE namespace=? AND msgid=?').run(reply.slice(0,16000), status, namespace, msgid);
  }
  get(msgid) { return this.store.db.prepare('SELECT * FROM wecom_inbox WHERE namespace=? AND msgid=?').get(this.namespace(), msgid); }
  history() {
    if (!this.config()) return [];
    return this.store.db.prepare('SELECT msgid,text,reply,status,created_at AS createdAt FROM wecom_inbox WHERE namespace=? ORDER BY created_at DESC LIMIT 100').all(this.namespace());
  }
}
