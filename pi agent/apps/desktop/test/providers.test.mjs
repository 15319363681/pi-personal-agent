import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramContractProvider } from '../src/runtime/providers/telegram-contract.mjs';

test('telegram adapter exposes a contract without claiming live delivery', async () => {
  const provider = new TelegramContractProvider();
  assert.deepEqual(provider.capabilities, { outbound: true, lookupDelivery: false, liveVerified: false });
  assert.throws(() => provider.validateConfig({}), /bot_token/);
  await assert.rejects(provider.send({}), /live_delivery_disabled/);
});
