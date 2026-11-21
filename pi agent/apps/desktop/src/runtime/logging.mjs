import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const allowedFields = new Set([
  'correlationId', 'taskId', 'deliveryId', 'provider', 'status', 'decision',
  'errorCode', 'reasonCode', 'attempt', 'recoveryMode', 'latencyMs', 'inputTokens',
  'outputTokens', 'costStatus', 'usageStatus', 'toolName', 'skillId', 'durationMs',
  'artifactId', 'serverId', 'mcpToolName', 'toolCount', 'pluginId', 'pluginVersion'
]);

export class LocalRuntimeLogger {
  constructor(dataDir) {
    this.dir = join(dataDir, 'logs');
    this.path = join(this.dir, 'runtime.jsonl');
  }

  async write(event, fields = {}) {
    const record = { timestamp: new Date().toISOString(), event };
    for (const [key, value] of Object.entries(fields)) {
      if (!allowedFields.has(key) || value === undefined || value === null) continue;
      if (typeof value === 'string') {
        if (key === 'errorCode' && !/^[a-z0-9_.-]{1,64}$/i.test(value)) continue;
        if (key === 'provider' && !/^[a-z0-9_.-]{1,48}$/i.test(value)) continue;
        if (key === 'toolName' && !/^[a-z0-9_.-]{1,64}$/i.test(value)) continue;
        if (key === 'skillId' && !/^[a-z0-9_.-]{1,64}$/i.test(value)) continue;
        if (key === 'pluginId' && !/^[a-z][a-z0-9_]{0,39}$/.test(value)) continue;
        if (key === 'serverId' && !/^[a-z0-9_-]{1,64}$/i.test(value)) continue;
        if (key === 'mcpToolName' && !/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) continue;
        record[key] = value.slice(0, 256);
      } else if (typeof value === 'boolean' || typeof value === 'number') record[key] = value;
    }
    if (!record.correlationId) record.correlationId = randomUUID();
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  }
}
