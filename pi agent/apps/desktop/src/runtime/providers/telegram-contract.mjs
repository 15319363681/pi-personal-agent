export class TelegramContractProvider {
  capabilities = { outbound: true, lookupDelivery: false, liveVerified: false };

  validateConfig(config = {}) {
    if (!config.bot_token) throw Error('bot_token_required');
    if (!config.chat_id) throw Error('chat_id_required');
    return { ok: true };
  }

  async connect() { return { status: 'contract-only' }; }
  async disconnect() {}
  async send() { throw Error('live_delivery_disabled'); }
}
