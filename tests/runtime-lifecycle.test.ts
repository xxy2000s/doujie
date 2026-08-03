import assert from 'node:assert/strict';
import test from 'node:test';
import { DoujieRuntimeLifecycle } from '../src/runtime-lifecycle.js';

const pollingConfig = {
  enabled: true,
  chatIds: ['oc_test'],
  as: 'user' as const,
  intervalMs: 1000,
  pageSize: 20,
};

function manualTimers(): {
  options: { operationTimeoutMs: number; setTimer: typeof setTimeout; clearTimer: typeof clearTimeout };
  runNext(): void;
} {
  let id = 0;
  const timers = new Map<number, () => void>();
  return {
    options: {
      operationTimeoutMs: 10,
      setTimer: ((callback: () => void) => {
        id += 1;
        timers.set(id, callback);
        return id as unknown as NodeJS.Timeout;
      }) as typeof setTimeout,
      clearTimer: ((timer: NodeJS.Timeout) => { timers.delete(timer as unknown as number); }) as typeof clearTimeout,
    },
    runNext() {
      const entry = timers.entries().next().value as [number, () => void] | undefined;
      assert.ok(entry, 'expected a pending lifecycle timeout');
      timers.delete(entry[0]);
      entry[1]();
    },
  };
}

test('runtime lifecycle cleans acquired resources after startup failure', async () => {
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); throw new Error('listen failed'); }, stop() { calls.push('listener.stop'); } },
    { start() { calls.push('watcher.start'); }, stop() { calls.push('watcher.stop'); } },
    { async reconcile() { calls.push('poller.reconcile'); }, async shutdown() { calls.push('poller.shutdown'); } }
  );
  await assert.rejects(lifecycle.start(pollingConfig), /listen failed/);
  assert.deepEqual(calls, ['poller.reconcile', 'listener.start', 'listener.stop', 'poller.shutdown']);
});

test('runtime lifecycle owns one listener and shuts down in reverse order exactly once', async () => {
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); }, stop() { calls.push('listener.stop'); } },
    { start() { calls.push('watcher.start'); }, async stop() { calls.push('watcher.stop'); } },
    { async reconcile() { calls.push('poller.reconcile'); }, async shutdown() { calls.push('poller.shutdown'); } }
  );
  await Promise.all([lifecycle.start(pollingConfig), lifecycle.start(pollingConfig)]);
  await Promise.all([lifecycle.shutdown(), lifecycle.shutdown()]);
  assert.deepEqual(calls, [
    'poller.reconcile', 'listener.start', 'watcher.start',
    'watcher.stop', 'listener.stop', 'poller.shutdown',
  ]);
});

test('runtime lifecycle stops all resources when watcher startup or cleanup fails', async () => {
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); }, stop() { calls.push('listener.stop'); } },
    {
      start() { calls.push('watcher.start'); throw new Error('watch failed'); },
      stop() { calls.push('watcher.stop'); throw new Error('stop failed'); },
    },
    { async reconcile() { calls.push('poller.reconcile'); }, async shutdown() { calls.push('poller.shutdown'); } }
  );
  await assert.rejects(lifecycle.start(pollingConfig), /stop failed/);
  await lifecycle.shutdown();
  assert.deepEqual(calls, [
    'poller.reconcile', 'listener.start', 'watcher.start',
    'watcher.stop', 'listener.stop', 'poller.shutdown',
  ]);
});

test('runtime lifecycle bounds stuck startup reconciliation and cleans the acquired poller', async () => {
  const timers = manualTimers();
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); }, stop() { calls.push('listener.stop'); } },
    { start() { calls.push('watcher.start'); }, stop() { calls.push('watcher.stop'); } },
    {
      async reconcile() { calls.push('poller.reconcile'); await new Promise<void>(() => undefined); },
      async shutdown() { calls.push('poller.shutdown'); },
    },
    timers.options
  );
  const starting = lifecycle.start(pollingConfig);
  await Promise.resolve();
  timers.runNext();
  await assert.rejects(starting, /poller startup timed out/);
  assert.deepEqual(calls, ['poller.reconcile', 'poller.shutdown']);
});

test('runtime lifecycle times out a stuck watcher reload wait then continues listener and poller cleanup', async () => {
  const timers = manualTimers();
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); }, stop() { calls.push('listener.stop'); } },
    {
      start() { calls.push('watcher.start'); },
      async stop() { calls.push('watcher.stop'); await new Promise<void>(() => undefined); },
    },
    { async reconcile() { calls.push('poller.reconcile'); }, async shutdown() { calls.push('poller.shutdown'); } },
    timers.options
  );
  await lifecycle.start(pollingConfig);
  const shutdown = lifecycle.shutdown();
  await Promise.resolve();
  timers.runNext();
  await assert.rejects(shutdown, /watcher cleanup timed out/);
  assert.deepEqual(calls, [
    'poller.reconcile', 'listener.start', 'watcher.start',
    'watcher.stop', 'listener.stop', 'poller.shutdown',
  ]);
});

test('runtime lifecycle bounds stuck poller shutdown after stopping watcher and listener', async () => {
  const timers = manualTimers();
  const calls: string[] = [];
  const lifecycle = new DoujieRuntimeLifecycle(
    { start() { calls.push('listener.start'); }, stop() { calls.push('listener.stop'); } },
    { start() { calls.push('watcher.start'); }, stop() { calls.push('watcher.stop'); } },
    {
      async reconcile() { calls.push('poller.reconcile'); },
      async shutdown() { calls.push('poller.shutdown'); await new Promise<void>(() => undefined); },
    },
    timers.options
  );
  await lifecycle.start(pollingConfig);
  const shutdown = lifecycle.shutdown();
  while (!calls.includes('poller.shutdown')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  timers.runNext();
  await assert.rejects(shutdown, /poller cleanup timed out/);
  assert.deepEqual(calls, [
    'poller.reconcile', 'listener.start', 'watcher.start',
    'watcher.stop', 'listener.stop', 'poller.shutdown',
  ]);
});
