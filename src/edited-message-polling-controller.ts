import type { AppConfig } from './types.js';
import type { ConfigLifecycleAction } from './runtime-config.js';

export type EditedMessagePollingConfig = AppConfig['feishu']['editPolling'];

export type ManagedEditedMessagePoller = {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
};

export type EditedMessagePollerFactory = (
  config: EditedMessagePollingConfig
) => ManagedEditedMessagePoller;

export class EditedMessagePollingController {
  private active: ManagedEditedMessagePoller | null = null;
  private activeConfig: EditedMessagePollingConfig | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private shutdownPromise: Promise<void> | null = null;

  constructor(private readonly factory: EditedMessagePollerFactory) {}

  reconcile(config: EditedMessagePollingConfig): Promise<ConfigLifecycleAction[]> {
    return this.enqueue(() => this.performReconcile(config));
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.closed = true;
      this.shutdownPromise = this.enqueue(() => this.stopActive());
    }
    return this.shutdownPromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async performReconcile(config: EditedMessagePollingConfig): Promise<ConfigLifecycleAction[]> {
    if (this.closed) throw new Error('edited-message polling controller is closed');
    const desired = structuredClone(config);
    const shouldRun = desired.enabled && desired.chatIds.length > 0;
    if (!shouldRun) {
      if (!this.active) return [];
      await this.stopActive();
      return ['poller:stop'];
    }
    if (this.active && configsEqual(this.activeConfig, desired)) return [];

    const replacing = Boolean(this.active);
    if (this.active) await this.stopActive();
    if (this.closed) throw new Error('edited-message polling controller is closed');
    const candidate = this.factory(desired);
    try {
      await candidate.start();
    } catch {
      try {
        await candidate.stop();
      } catch {
        // The caller receives one sanitized reconciliation failure.
      }
      throw new Error('edited-message poller failed to start');
    }
    if (this.closed) {
      try {
        await candidate.stop();
      } catch {
        // A late candidate can never become active after shutdown ownership is declared.
      }
      throw new Error('edited-message polling controller is closed');
    }
    this.active = candidate;
    this.activeConfig = desired;
    return [replacing ? 'poller:replace' : 'poller:start'];
  }

  private async stopActive(): Promise<void> {
    const current = this.active;
    if (!current) return;
    await current.stop();
    if (this.active === current) {
      this.active = null;
      this.activeConfig = null;
    }
  }
}

function configsEqual(
  left: EditedMessagePollingConfig | null,
  right: EditedMessagePollingConfig
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}
