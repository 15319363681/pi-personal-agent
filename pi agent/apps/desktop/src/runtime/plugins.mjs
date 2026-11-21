import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';

const validator = new AjvJsonSchemaValidator();
const definitionFields = ['id', 'name', 'description', 'source', 'inputSchema', 'tests'];
const schemaFields = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum']);
const error = (code) => Object.assign(new Error(code), { code });

function fields(value, allowed, code = 'plugin_request_invalid') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw error(code);
}

export function boundedPluginJson(value, code = 'plugin_arguments_invalid') {
  let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 4096 || depth > 12) throw error(code);
    if (item === null || typeof item === 'boolean' || typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item))) return;
    if (!item || typeof item !== 'object') throw error(code);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw error(code);
    for (const [key, child] of Object.entries(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw error(code);
      visit(child, depth + 1);
    }
  }
  visit(value, 0);
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 32768) throw error(code);
  return JSON.parse(text);
}

function normalizeSchema(schema, depth = 0) {
  const code = 'plugin_definition_invalid';
  fields(schema, [...schemaFields], code);
  if (depth > 8 || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) throw error(code);
  if (schema.type === 'object') {
    if (schema.additionalProperties !== false || !schema.properties || Array.isArray(schema.properties) || typeof schema.properties !== 'object') throw error(code);
    for (const child of Object.values(schema.properties)) normalizeSchema(child, depth + 1);
  }
  if (schema.type === 'array') normalizeSchema(schema.items, depth + 1);
}

export function normalizePluginDefinition(value) {
  const code = 'plugin_definition_invalid';
  fields(value, definitionFields, code);
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(value.id ?? '') || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 ||
      typeof value.description !== 'string' || !value.description.trim() || value.description.length > 1000 || typeof value.source !== 'string' || !value.source.trim() || Buffer.byteLength(value.source) > 32768 ||
      !Array.isArray(value.tests) || value.tests.length < 1 || value.tests.length > 8) throw error(code);
  try {
    if (value.inputSchema?.type !== 'object' || Buffer.byteLength(JSON.stringify(value.inputSchema)) > 8192) throw error(code);
    normalizeSchema(value.inputSchema);
    const validate = validator.getValidator(value.inputSchema);
    for (const sample of value.tests) {
      fields(sample, ['name', 'input', 'expected'], code);
      if (typeof sample.name !== 'string' || !sample.name.trim() || sample.name.length > 80) throw error(code);
      const input = boundedPluginJson(sample.input, code);
      boundedPluginJson(sample.expected, code);
      if (!validate(input).valid) throw error(code);
    }
    return structuredClone(value);
  } catch { throw error(code); }
}

export class RuntimePlugins {
  constructor({ store, dataDir, logger, worker }) {
    this.store = store;
    this.dataDir = dataDir;
    this.logger = logger;
    this.worker = worker;
    this.pending = new Set();
    this.testing = new Set();
    this.closed = false;
    store.db.exec('CREATE TABLE IF NOT EXISTS plugins(id TEXT PRIMARY KEY,version INTEGER NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,approved_version INTEGER,deleted INTEGER NOT NULL DEFAULT 0); CREATE TABLE IF NOT EXISTS plugin_versions(id TEXT NOT NULL,version INTEGER NOT NULL,definition_json TEXT NOT NULL,hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(id,version)); CREATE TABLE IF NOT EXISTS plugin_tests(test_id TEXT PRIMARY KEY,id TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,cases_json TEXT NOT NULL,created_at INTEGER NOT NULL,duration_ms INTEGER NOT NULL);');
  }

  row(id) {
    if (typeof id !== 'string') throw error('plugin_request_invalid');
    const row = this.store.db.prepare('SELECT * FROM plugins WHERE id=? AND deleted=0').get(id);
    if (!row) throw error('plugin_not_found');
    return row;
  }

  current(id, version) {
    if (this.closed) throw error('plugin_closed');
    const row = this.row(id);
    if (!Number.isSafeInteger(version) || version !== row.version) throw error('plugin_version_conflict');
    return row;
  }

  version(id, version) {
    return this.store.db.prepare('SELECT * FROM plugin_versions WHERE id=? AND version=?').get(id, version);
  }

  testStatus(id, version) {
    return this.store.db.prepare('SELECT status FROM plugin_tests WHERE id=? AND version=? ORDER BY rowid DESC LIMIT 1').get(id, version)?.status ?? 'untested';
  }

  summary(row) {
    const version = this.version(row.id, row.version);
    const definition = JSON.parse(version.definition_json);
    return { id: row.id, name: definition.name, description: definition.description, version: row.version, enabled: Boolean(row.enabled), approvedVersion: row.approved_version, testStatus: this.testStatus(row.id, row.version), hash: version.hash };
  }

  list() {
    return this.store.db.prepare('SELECT * FROM plugins WHERE deleted=0 ORDER BY id').all().map((row) => this.summary(row));
  }

  get(params) {
    fields(params, ['id']);
    const row = this.row(params.id);
    const versions = this.store.db.prepare('SELECT * FROM plugin_versions WHERE id=? ORDER BY version DESC').all(row.id).map((v) => ({ version: v.version, hash: v.hash, createdAt: v.created_at, definition: JSON.parse(v.definition_json) }));
    const tests = this.store.db.prepare('SELECT * FROM plugin_tests WHERE id=? ORDER BY rowid DESC').all(row.id).map((t) => ({ id: t.test_id, version: t.version, status: t.status, cases: JSON.parse(t.cases_json), createdAt: t.created_at, durationMs: t.duration_ms }));
    return { ...this.summary(row), definition: versions[0].definition, versions, tests };
  }

  async log(event, id, version, status, extra = {}) {
    await this.logger?.write(event, { pluginId: id, pluginVersion: version, status, ...extra });
  }

  async saveDraft(params) {
    fields(params, ['definition', 'baseVersion']);
    if (this.closed) throw error('plugin_closed');
    const definition = normalizePluginDefinition(params.definition);
    const result = this.store.transaction(() => {
      const current = this.store.db.prepare('SELECT * FROM plugins WHERE id=?').get(definition.id);
      if (current && !current.deleted && params.baseVersion !== current.version) throw error('plugin_version_conflict');
      if ((!current || current.deleted) && params.baseVersion !== undefined) throw error('plugin_version_conflict');
      const version = (current?.version ?? 0) + 1;
      const text = JSON.stringify(definition);
      const hash = createHash('sha256').update(text).digest('hex');
      this.store.db.prepare('INSERT INTO plugin_versions VALUES (?,?,?,?,?)').run(definition.id, version, text, hash, Date.now());
      this.store.db.prepare('INSERT OR REPLACE INTO plugins VALUES (?,?,0,NULL,0)').run(definition.id, version);
      return this.summary(this.row(definition.id));
    });
    await this.log('plugin.draft_saved', result.id, result.version, 'draft');
    return result;
  }

  track(operation) {
    this.pending.add(operation);
    operation.finally(() => this.pending.delete(operation)).catch(() => {});
    return operation;
  }

  testPlugin(params) {
    return this.track(this.performTest(params));
  }

  async performTest(params) {
    fields(params, ['id', 'version']);
    const row = this.current(params.id, params.version);
    if (this.testing.has(row.id)) throw error('plugin_busy');
    this.testing.add(row.id);
    this.store.db.prepare('UPDATE plugins SET enabled=0,approved_version=NULL WHERE id=?').run(row.id);
    const definition = JSON.parse(this.version(row.id, row.version).definition_json);
    const started = Date.now();
    const cases = [];
    try {
      for (const sample of definition.tests) {
        try {
          if (!this.worker) throw error('plugin_isolation_unavailable');
          const output = boundedPluginJson(await this.worker.run({ source: definition.source, input: sample.input }), 'plugin_output_invalid');
          const status = isDeepStrictEqual(output, sample.expected) ? 'passed' : 'failed';
          cases.push({ name: sample.name, status, ...(status === 'failed' ? { errorCode: 'plugin_test_mismatch' } : {}) });
        } catch (cause) {
          const errorCode = /^plugin_[a-z_]{1,48}$/.test(cause.code ?? '') ? cause.code : 'plugin_execution_failed';
          cases.push({ name: sample.name, status: 'failed', errorCode });
        }
      }
      const result = { id: randomUUID(), pluginId: row.id, version: row.version, status: cases.every((c) => c.status === 'passed') ? 'passed' : 'failed', cases, createdAt: started, durationMs: Date.now() - started };
      this.store.db.prepare('INSERT INTO plugin_tests VALUES (?,?,?,?,?,?,?)').run(result.id, row.id, row.version, result.status, JSON.stringify(cases), started, result.durationMs);
      await this.log('plugin.test_finished', row.id, row.version, result.status, { durationMs: result.durationMs });
      return result;
    } finally { this.testing.delete(row.id); }
  }

  async setEnabled(params) {
    fields(params, ['id', 'version', 'enabled', 'confirm']);
    if (typeof params.enabled !== 'boolean') throw error('plugin_request_invalid');
    const result = this.store.transaction(() => {
      const row = this.current(params.id, params.version);
      if (this.testing.has(row.id)) throw error('plugin_busy');
      if (params.enabled && this.testStatus(row.id, row.version) !== 'passed') throw error('plugin_test_required');
      if (params.enabled && params.confirm !== true) throw error('plugin_confirmation_required');
      this.store.db.prepare('UPDATE plugins SET enabled=?,approved_version=? WHERE id=?').run(params.enabled ? 1 : 0, params.enabled ? row.version : null, row.id);
      return this.summary(this.row(row.id));
    });
    await this.log('plugin.state_changed', result.id, result.version, result.enabled ? 'enabled' : 'disabled');
    return result;
  }

  approved(id, version) {
    const row = this.current(id, version);
    if (!row.enabled || row.approved_version !== version || this.testStatus(id, version) !== 'passed') throw error('plugin_not_enabled');
    return row;
  }

  run(params) {
    return this.track(this.performRun(params));
  }

  async performRun(params) {
    fields(params, ['id', 'version', 'arguments']);
    const row = this.approved(params.id, params.version);
    const definition = JSON.parse(this.version(row.id, row.version).definition_json);
    const input = boundedPluginJson(params.arguments);
    if (!validator.getValidator(definition.inputSchema)(input).valid) throw error('plugin_arguments_invalid');
    const started = Date.now();
    try {
      if (!this.worker) throw error('plugin_isolation_unavailable');
      const output = boundedPluginJson(await this.worker.run({ source: definition.source, input }), 'plugin_output_invalid');
      this.approved(params.id, params.version);
      await this.log('plugin.run_finished', row.id, row.version, 'succeeded', { durationMs: Date.now() - started });
      return output;
    } catch (cause) {
      const code = /^plugin_[a-z_]{1,48}$/.test(cause.code ?? '') ? cause.code : 'plugin_execution_failed';
      await this.log('plugin.run_finished', row.id, row.version, 'failed', { errorCode: code, durationMs: Date.now() - started });
      throw error(code);
    }
  }

  async remove(params) {
    fields(params, ['id', 'version']);
    this.current(params.id, params.version);
    this.store.db.prepare('UPDATE plugins SET deleted=1,enabled=0,approved_version=NULL WHERE id=?').run(params.id);
    await this.log('plugin.removed', params.id, params.version, 'deleted');
    return { removed: true };
  }

  createDevelopmentTools() {
    return [
      {
        name: 'plugin_save_draft', label: '保存本地插件草稿',
        description: '为用户创建或更新纯 JSON 数据处理插件。source 是同步 JavaScript 函数表达式，如 (input) => ({length: input.text.length})。无文件、网络或宿主 API。inputSchema 根类型必须 object，所有对象 additionalProperties:false。tests 至少一个 {name,input,expected}。更新前用 plugin_inspect 获取版本并填写 baseVersion。保存后默认停用，调用 plugin_test 后请用户在插件面板审核确认。',
        parameters: { type: 'object', properties: {
          definition: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, source: { type: 'string' }, inputSchema: { type: 'object', additionalProperties: true }, tests: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'object', properties: { name: { type: 'string' }, input: {}, expected: {} }, required: ['name', 'input', 'expected'], additionalProperties: false } } }, required: definitionFields, additionalProperties: false },
          baseVersion: { type: 'integer' }
        }, required: ['definition'], additionalProperties: false },
        executionMode: 'sequential',
        execute: async (_id, params) => ({ content: [{ type: 'text', text: JSON.stringify(await this.saveDraft(params)) }] })
      },
      {
        name: 'plugin_test', label: '隔离测试插件草稿',
        description: '在受限 Worker 中运行指定当前版本的样例测试。记录仅保存在本机。测试通过后仍需用户在插件面板审核并确认启用。',
        parameters: { type: 'object', properties: { id: { type: 'string' }, version: { type: 'integer' } }, required: ['id', 'version'], additionalProperties: false },
        executionMode: 'sequential',
        execute: async (_id, params) => ({ content: [{ type: 'text', text: JSON.stringify(await this.testPlugin(params)) }] })
      },
      {
        name: 'plugin_inspect', label: '查看本地插件',
        description: '省略 id 时列出本地插件版本和状态，提供 id 时读取当前源码、schema、测试样例和最近测试结果，用于修改已有插件。',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, additionalProperties: false },
        executionMode: 'sequential',
        execute: async (_id, params) => {
          fields(params, ['id']);
          const value = params.id ? this.get(params) : this.list();
          if (params.id) { delete value.versions; value.tests = value.tests.slice(0, 1); }
          return { content: [{ type: 'text', text: JSON.stringify(value) }] };
        }
      }
    ];
  }

  createPiTools() {
    return this.list().filter((p) => p.enabled && p.approvedVersion === p.version && p.testStatus === 'passed').map((plugin) => ({
      name: 'plugin_' + plugin.id + '_v' + plugin.version,
      label: plugin.name,
      description: '用户已确认的本地纯 JSON 插件。' + plugin.description,
      parameters: JSON.parse(this.version(plugin.id, plugin.version).definition_json).inputSchema,
      executionMode: 'sequential',
      execute: async (_id, args) => ({ content: [{ type: 'text', text: JSON.stringify(await this.run({ id: plugin.id, version: plugin.version, arguments: args })) }] })
    }));
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
    await this.worker?.close?.();
  }
}
