export class ModelClient {
  constructor({ fetchImpl = fetch, timeoutMs = 90_000 } = {}) { this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs; }

  async complete(setting, apiKey, messages) {
    if (!['openai-compatible', 'openai-responses'].includes(setting.provider)) throw Object.assign(new Error('Unsupported model provider'), { code: 'unsupported_provider' });
    if (!setting.model || !setting.baseUrl || !apiKey) throw Object.assign(new Error('Model, endpoint and API key are required'), { code: 'model_configuration_incomplete' });
    let base;
    try { base = new URL(setting.baseUrl); } catch { throw Object.assign(new Error('Invalid provider endpoint'), { code: 'model_endpoint_invalid' }); }
    const localHttp = base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !localHttp) throw Object.assign(new Error('Provider endpoint must use HTTPS'), { code: 'model_endpoint_must_use_https' });
    if (base.username || base.password || base.search || base.hash) throw Object.assign(new Error('Provider endpoint must not contain credentials or query data'), { code: 'model_endpoint_invalid' });
    const responsesApi = setting.provider === 'openai-responses' || setting.apiFormat === 'responses';
    const endpoint = `${base.toString().replace(/\/+$/, '')}/${responsesApi ? 'responses' : 'chat/completions'}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(responsesApi ? { model: setting.model, input: messages, store: false } : { model: setting.model, messages }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'model_auth_failed' : response.status === 429 ? 'model_rate_limited' : 'model_request_failed';
        throw Object.assign(new Error('Provider request failed'), { code, status: response.status });
      }
      const data = await response.json();
      const content = responsesApi
        ? data.output_text ?? data.output?.flatMap((item) => item.content ?? []).find((part) => part.type === 'output_text')?.text
        : data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw Object.assign(new Error('Provider returned no message'), { code: 'model_empty_response' });
      return {
        content,
        usage: data.usage ? { inputTokens: data.usage.input_tokens ?? data.usage.prompt_tokens ?? null, outputTokens: data.usage.output_tokens ?? data.usage.completion_tokens ?? null, totalTokens: data.usage.total_tokens ?? null, costStatus: 'unknown' } : { inputTokens: null, outputTokens: null, totalTokens: null, costStatus: 'unknown' }
      };
    } catch (error) {
      if (error.name === 'AbortError') throw Object.assign(new Error('Model request timed out; provider usage is unknown'), { code: 'model_timeout', usageStatus: 'unknown' });
      if (error.code) throw error;
      throw Object.assign(new Error('Could not reach model provider; provider usage is unknown'), { code: 'model_network_error', usageStatus: 'unknown' });
    } finally { clearTimeout(timeout); }
  }

  async testConnection(setting, apiKey) {
    const response = await this.complete(setting, apiKey, [{ role: 'user', content: 'Reply with OK.' }]);
    return { status: 'connected', usage: response.usage };
  }
}
