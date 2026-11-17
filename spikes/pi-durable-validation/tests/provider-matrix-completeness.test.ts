import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from 'vitest';

const matrixPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/superpowers/evidence/2026-11-17-provider-capability-matrix.json');
const registered = ['terminal', 'web', 'wechatmp', 'wechatmp_service', 'wechatcom_app', 'wechat_kf', 'feishu', 'dingtalk', 'wecom_bot', 'qq', 'telegram', 'slack', 'discord', 'weixin'];

test('matrix_covers_each_registered_provider_and_marks_evidence_kind', async () => {
  const matrix = JSON.parse(await readFile(matrixPath, 'utf8'));
  expect(matrix.providers.map((p: any) => p.type).sort()).toEqual([...registered].sort());
  for (const provider of matrix.providers) {
    for (const field of ['outboundText', 'attachments', 'authConfiguration', 'publicCallback', 'receiptQuery', 'idempotency', 'rateLimits', 'windowsRuntime', 'disconnectRevoke']) {
      const value = provider.capabilities[field];
      expect(value).toBeTruthy();
      if (typeof value === 'object' && value.status === 'unknown') expect(value.reason.length).toBeGreaterThan(10);
    }
    expect(provider.sourceEvidence.length).toBeGreaterThan(0);
    expect(['not_run', 'pass']).toContain(provider.runtimeVerification.status);
    if (provider.runtimeVerification.status === 'pass') {
      expect(provider.runtimeVerification.evidence).toBeTruthy();
      expect(provider.runtimeVerification.scope).toBe('loopback_protocol_only');
    }
    expect(provider.realDeliveryVerification.status).toBe('not_run');
  }
  expect(matrix.sourceQualifiedCandidates).toEqual(['telegram']);
  expect(matrix.v1OutboundCandidates).toEqual([]);
});
