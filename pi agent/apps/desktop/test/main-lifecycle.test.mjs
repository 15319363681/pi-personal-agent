import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const mainSource = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
const callbackStart = mainSource.indexOf("app.on('before-quit',");
const callbackEnd = mainSource.indexOf("app.on('window-all-closed',", callbackStart);
assert.ok(callbackStart >= 0 && callbackEnd > callbackStart, 'production before-quit registration must exist');
const registration = mainSource.slice(callbackStart, callbackEnd);

function lifecycle(runtimeClient) {
  let beforeQuit;
  let closeCalls = 0;
  let killCalls = 0;
  let quitCalls = 0;
  const resumedEvents = [];
  const context = {
    wecom: undefined,
    scheduler: undefined,
    runtimeClient: runtimeClient && { close() { closeCalls++; return runtimeClient.close(); } },
    runtimeProcess: runtimeClient && { killed: false, kill() { killCalls++; } },
    app: {
      on(event, callback) {
        assert.equal(event, 'before-quit');
        beforeQuit = callback;
      },
      quit() {
        quitCalls++;
        resumedEvents.push(quit());
      }
    }
  };
  // Execute the actual production registration with in-memory Electron and RPC
  // dependencies so assertions exercise the callback shipped in main.mjs.
  const state = runInNewContext(`
    let quitting = false;
    let runtimeShutdown;
    let shutdownComplete = false;
    ${registration}
    ({
      get quitting() { return quitting; },
      get runtimeShutdown() { return runtimeShutdown; },
      get shutdownComplete() { return shutdownComplete; }
    })
  `, context);
  function quit() {
    const event = { prevented: false, preventDefault() { this.prevented = true; } };
    beforeQuit(event);
    return event;
  }
  return {
    quit, state, resumedEvents,
    clearRuntime() { context.runtimeClient = undefined; },
    get closeCalls() { return closeCalls; },
    get killCalls() { return killCalls; },
    get quitCalls() { return quitCalls; }
  };
}

test('production before-quit prevents exit while Runtime close is pending', async () => {
  const shutdown = Promise.withResolvers();
  const host = lifecycle({ close: () => shutdown.promise });
  const event = host.quit();
  assert.equal(event.prevented, true);
  assert.equal(host.state.quitting, true);
  assert.equal(host.closeCalls, 1);
  assert.equal(host.killCalls, 0);
  assert.equal(host.quitCalls, 0);
  assert.equal(host.state.shutdownComplete, false);
  await Promise.resolve();
  assert.equal(host.quitCalls, 0, 'pending Runtime shutdown must keep the application alive');
  shutdown.resolve();
  await host.state.runtimeShutdown;
});

test('repeated production quit requests reuse the pending Runtime shutdown', async () => {
  const shutdown = Promise.withResolvers();
  const host = lifecycle({ close: () => shutdown.promise });
  host.quit();
  const pending = host.state.runtimeShutdown;
  assert.equal(host.quit().prevented, true);
  assert.equal(host.state.runtimeShutdown, pending);
  assert.equal(host.closeCalls, 1);
  // Runtime emits exit before close, clearing the production runtimeClient.
  host.clearRuntime();
  assert.equal(host.quit().prevented, true);
  assert.equal(host.state.runtimeShutdown, pending);
  assert.equal(host.closeCalls, 1);
  assert.equal(host.killCalls, 0);
  assert.equal(host.quitCalls, 0);
  shutdown.resolve();
  await pending;
});

test('production shutdown completion resumes app.quit exactly once and allows exit', async () => {
  const shutdown = Promise.withResolvers();
  const host = lifecycle({ close: () => shutdown.promise });
  host.quit();
  shutdown.resolve();
  await host.state.runtimeShutdown;
  assert.equal(host.state.shutdownComplete, true);
  assert.equal(host.quitCalls, 1);
  assert.equal(host.resumedEvents.length, 1);
  assert.equal(host.resumedEvents[0].prevented, false);
  assert.equal(host.quit().prevented, false);
  assert.equal(host.closeCalls, 1);
  assert.equal(host.killCalls, 0);
  assert.equal(host.quitCalls, 1);
});

test('production before-quit allows immediate exit when no Runtime exists', () => {
  const host = lifecycle();
  assert.equal(host.quit().prevented, false);
  assert.equal(host.state.quitting, true);
  assert.equal(host.state.runtimeShutdown, undefined);
  assert.equal(host.closeCalls, 0);
  assert.equal(host.killCalls, 0);
  assert.equal(host.quitCalls, 0);
});
