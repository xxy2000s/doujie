import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EditedMessagePollingController,
  type EditedMessagePollingConfig,
} from '../src/edited-message-polling-controller.js';

const enabled: EditedMessagePollingConfig = {
  enabled: true,
  chatIds: ['chat-a'],
  as: 'user',
  intervalMs: 1000,
  pageSize: 20,
};

test('EditedMessagePollingController serializes replacement without overlap', async () => {
  let active = 0;
  let maximumActive = 0;
  let releaseFirstStop!: () => void;
  const firstStop = new Promise<void>((resolve) => { releaseFirstStop = resolve; });
  let created = 0;
  const controller = new EditedMessagePollingController(() => {
    const index = created++;
    return {
      start() {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
      },
      async stop() {
        if (index === 0) await firstStop;
        active -= 1;
      },
    };
  });

  assert.deepEqual(await controller.reconcile(enabled), ['poller:start']);
  const replacing = controller.reconcile({ ...enabled, intervalMs: 2000 });
  await Promise.resolve();
  assert.equal(created, 1);
  releaseFirstStop();
  assert.deepEqual(await replacing, ['poller:replace']);
  assert.equal(maximumActive, 1);
  assert.equal(active, 1);
  await controller.shutdown();
  await controller.shutdown();
  assert.equal(active, 0);
});

test('EditedMessagePollingController stops, deduplicates, and retries failed reconciliation', async () => {
  let starts = 0;
  let stops = 0;
  let fail = true;
  const controller = new EditedMessagePollingController(() => ({
    start() {
      starts += 1;
      if (fail) throw new Error('secret startup output');
    },
    stop() { stops += 1; },
  }));

  await assert.rejects(controller.reconcile(enabled), /failed to start/);
  fail = false;
  assert.deepEqual(await controller.reconcile(enabled), ['poller:start']);
  assert.deepEqual(await controller.reconcile(enabled), []);
  assert.deepEqual(await controller.reconcile({ ...enabled, enabled: false }), ['poller:stop']);
  assert.equal(starts, 2);
  assert.equal(stops, 2);
  await controller.shutdown();
});

test('EditedMessagePollingController retains ownership when stop fails and never starts a replacement', async () => {
  let created = 0;
  let stopAttempts = 0;
  let stopFails = true;
  const controller = new EditedMessagePollingController(() => {
    created += 1;
    return {
      start() {},
      stop() {
        stopAttempts += 1;
        if (stopFails) throw new Error('stop details');
      },
    };
  });

  await controller.reconcile(enabled);
  await assert.rejects(controller.reconcile({ ...enabled, intervalMs: 3000 }), /stop details/);
  assert.equal(created, 1);
  stopFails = false;
  assert.deepEqual(await controller.reconcile({ ...enabled, intervalMs: 3000 }), ['poller:replace']);
  assert.equal(created, 2);
  assert.equal(stopAttempts, 2);
  await controller.shutdown();
});

test('EditedMessagePollingController prevents a late reconcile from acquiring ownership after shutdown', async () => {
  let releaseStart!: () => void;
  const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
  let stops = 0;
  const controller = new EditedMessagePollingController(() => ({
    async start() { await startGate; },
    stop() { stops += 1; },
  }));
  const reconcile = controller.reconcile(enabled);
  await Promise.resolve();
  const shutdown = controller.shutdown();
  releaseStart();
  await assert.rejects(reconcile, /closed/);
  await shutdown;
  assert.equal(stops, 1);
  await assert.rejects(controller.reconcile(enabled), /closed/);
});
