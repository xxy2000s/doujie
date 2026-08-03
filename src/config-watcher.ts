import fs from 'node:fs';
import path from 'node:path';
import type { RuntimeConfigWatcherState } from './runtime-config.js';

type WatchHandle = {
  close(): void;
  on?(event: 'error', listener: () => void): unknown;
};
type WatchFactory = (
  directory: string,
  listener: (eventType: string, filename: string | Buffer | null) => void
) => WatchHandle;

export type ConfigFileWatcherOptions = {
  debounceMs?: number;
  retryInitialMs?: number;
  retryMaxMs?: number;
  watch?: WatchFactory;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  onStateChange?: (state: RuntimeConfigWatcherState) => void;
};

export class ConfigFileWatcher {
  private readonly directory: string;
  private readonly filename: string;
  private readonly debounceMs: number;
  private readonly retryInitialMs: number;
  private readonly retryMaxMs: number;
  private readonly watchFactory: WatchFactory;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;
  private readonly onStateChange: (state: RuntimeConfigWatcherState) => void;
  private handle: WatchHandle | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelayMs: number;
  private reloadQueue: Promise<void> = Promise.resolve();
  private stopped = true;

  constructor(
    configFile: string,
    private readonly reload: () => Promise<boolean>,
    options: ConfigFileWatcherOptions = {}
  ) {
    this.directory = path.dirname(configFile);
    this.filename = path.basename(configFile);
    this.debounceMs = options.debounceMs ?? 250;
    this.retryInitialMs = options.retryInitialMs ?? 500;
    this.retryMaxMs = options.retryMaxMs ?? 30000;
    this.retryDelayMs = this.retryInitialMs;
    this.watchFactory = options.watch ?? ((directory, listener) => fs.watch(directory, listener));
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onStateChange = options.onStateChange ?? (() => undefined);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.onStateChange('starting');
    this.openWatch();
  }

  private openWatch(): void {
    if (this.stopped || this.handle) return;
    try {
      const handle = this.watchFactory(this.directory, (_eventType, filename) => {
        const observed = typeof filename === 'string' ? filename : filename?.toString();
        if (observed && observed !== this.filename) return;
        this.scheduleReload();
      });
      this.handle = handle;
      handle.on?.('error', () => this.handleWatchError(handle));
      this.onStateChange('watching');
    } catch {
      this.onStateChange('degraded');
      this.scheduleWatchRetry();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.debounceTimer) {
      this.clearTimer(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.retryTimer) {
      this.clearTimer(this.retryTimer);
      this.retryTimer = null;
    }
    try {
      this.handle?.close();
    } catch {
      // Shutdown remains idempotent even for an invalid native handle.
    }
    this.handle = null;
    await this.reloadQueue;
    this.onStateChange('stopped');
  }

  private scheduleReload(): void {
    if (this.stopped) return;
    if (this.debounceTimer) this.clearTimer(this.debounceTimer);
    this.debounceTimer = this.setTimer(() => {
      this.debounceTimer = null;
      this.reloadQueue = this.reloadQueue.then(async () => {
        if (this.stopped) return;
        try {
          const ok = await this.reload();
          if (ok) this.retryDelayMs = this.retryInitialMs;
          this.onStateChange(ok ? 'watching' : 'degraded');
        } catch {
          this.onStateChange('degraded');
        }
      });
    }, this.debounceMs);
  }

  private handleWatchError(handle: WatchHandle): void {
    if (this.stopped || this.handle !== handle) return;
    try {
      handle.close();
    } catch {
      // The invalid handle is detached even if close itself fails.
    }
    this.handle = null;
    this.onStateChange('degraded');
    this.scheduleWatchRetry();
  }

  private scheduleWatchRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxMs);
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      this.openWatch();
    }, delay);
  }
}
