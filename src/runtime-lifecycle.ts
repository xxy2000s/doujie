import type { EditedMessagePollingConfig } from './edited-message-polling-controller.js';

export type RuntimeListener = {
  start(): void;
  stop(): void;
};

export type RuntimeWatcher = {
  start(): void;
  stop(): void | Promise<void>;
};

export type RuntimePollingController = {
  reconcile(config: EditedMessagePollingConfig): Promise<unknown>;
  shutdown(): Promise<void>;
};

export type RuntimeLifecycleOptions = {
  operationTimeoutMs?: number;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
};

export class DoujieRuntimeLifecycle {
  private startPromise: Promise<void> | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private pollerOwned = false;
  private listenerOwned = false;
  private watcherOwned = false;

  constructor(
    private readonly listener: RuntimeListener,
    private readonly watcher: RuntimeWatcher,
    private readonly pollingController: RuntimePollingController,
    private readonly options: RuntimeLifecycleOptions = {}
  ) {}

  start(initialPollingConfig: EditedMessagePollingConfig): Promise<void> {
    if (this.shutdownPromise) return Promise.reject(new Error('runtime lifecycle is shutting down'));
    if (!this.startPromise) {
      this.startPromise = this.performStart(initialPollingConfig);
    }
    return this.startPromise;
  }

  shutdown(): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        if (this.startPromise) {
          try {
            await this.startPromise;
          } catch {
            // Startup already attempted cleanup; retry any still-owned resource below.
          }
        }
        await this.cleanup();
      })();
    }
    return this.shutdownPromise;
  }

  private async performStart(initialPollingConfig: EditedMessagePollingConfig): Promise<void> {
    try {
      this.pollerOwned = true;
      await this.runBounded(
        Promise.resolve().then(() => this.pollingController.reconcile(initialPollingConfig)),
        'poller startup'
      );
      this.listenerOwned = true;
      this.listener.start();
      this.watcherOwned = true;
      this.watcher.start();
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }

  private async cleanup(): Promise<void> {
    let firstError: unknown = null;
    if (this.watcherOwned) {
      this.watcherOwned = false;
      try {
        await this.runBounded(Promise.resolve().then(() => this.watcher.stop()), 'watcher cleanup');
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.listenerOwned) {
      this.listenerOwned = false;
      try {
        await this.runBounded(Promise.resolve().then(() => this.listener.stop()), 'listener cleanup');
      } catch (error) {
        firstError ??= error;
      }
    }
    if (this.pollerOwned) {
      this.pollerOwned = false;
      try {
        await this.runBounded(Promise.resolve().then(() => this.pollingController.shutdown()), 'poller cleanup');
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  }

  private runBounded<T>(operation: Promise<T>, label: string): Promise<T> {
    const timeoutMs = this.options.operationTimeoutMs ?? 2000;
    const setTimer = this.options.setTimer ?? setTimeout;
    const clearTimer = this.options.clearTimer ?? clearTimeout;
    let timer: NodeJS.Timeout | null = null;
    const observed = operation.then(
      (value) => ({ kind: 'value' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error })
    );
    const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
      timer = setTimer(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    return Promise.race([observed, timeout]).then((result) => {
      if (timer) clearTimer(timer);
      if (result.kind === 'timeout') throw new Error(`${label} timed out`);
      if (result.kind === 'error') throw result.error;
      return result.value;
    });
  }
}
