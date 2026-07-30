import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { ChildProcess } from 'node:child_process';
import type { FeishuEvent, FeishuIdentity } from './types.js';

export type EventHandler = (event: FeishuEvent) => void;
export type ListenerState = 'stopped' | 'starting' | 'running' | 'restarting';

export type ListenerStatus = {
  state: ListenerState;
  lastEventAt: number | null;
  restartCount: number;
};

export const MESSAGE_RECEIVE_EVENT = 'im.message.receive_v1';
export const MESSAGE_UPDATED_EVENTS = [
  'im.message.message_updated_v1',
  'im.message.updated_v1',
] as const;
export const DEFAULT_EVENT_TYPES = [
  MESSAGE_RECEIVE_EVENT,
  ...MESSAGE_UPDATED_EVENTS,
] as const;

const MESSAGE_EVENT_TYPES = new Set<string>(DEFAULT_EVENT_TYPES);

export function buildSubscribeArgs(
  feishuAs: FeishuIdentity,
  eventTypes: readonly string[] = DEFAULT_EVENT_TYPES
): string[] {
  const args = [
    'event',
    '+subscribe',
    '--as',
    feishuAs,
  ];
  if (eventTypes.length > 0) {
    args.push('--event-types', eventTypes.join(','));
  }
  return args;
}

export class EventListener {
  private process: ChildProcess | null = null;
  private restartDelay = 1000;
  private maxRestartDelay = 30000;
  private shouldRun = true;
  private handler: EventHandler;
  private allowedChatIds: string[];
  private feishuAs: FeishuIdentity;
  private eventTypes: readonly string[];
  private state: ListenerState = 'stopped';
  private lastEventAt: number | null = null;
  private restartCount = 0;

  constructor(
    handler: EventHandler,
    allowedChatIds: string[],
    feishuAs: FeishuIdentity = 'bot',
    eventTypes: readonly string[] = DEFAULT_EVENT_TYPES
  ) {
    this.handler = handler;
    this.allowedChatIds = allowedChatIds;
    this.feishuAs = feishuAs;
    this.eventTypes = eventTypes;
  }

  start(): void {
    this.shouldRun = true;
    this.state = 'starting';
    this.spawnProcess();
  }

  stop(): void {
    this.shouldRun = false;
    this.state = 'stopped';
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = null;
    }
  }

  getStatus(): ListenerStatus {
    return {
      state: this.state,
      lastEventAt: this.lastEventAt,
      restartCount: this.restartCount,
    };
  }

  private spawnProcess(): void {
    if (!this.shouldRun) return;

    console.log('[listener] Starting lark-cli event +subscribe...');
    this.state = this.restartCount > 0 ? 'restarting' : 'starting';
    this.process = spawn('lark-cli', buildSubscribeArgs(this.feishuAs, this.eventTypes), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.restartDelay = 1000;
    this.state = 'running';

    const stdout = this.process.stdout;
    if (!stdout) {
      console.error('[listener] No stdout from lark-cli process');
      return;
    }

    const rl = readline.createInterface({
      input: stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line: string) => {
      this.handleLine(line);
    });

    const stderr = this.process.stderr;
    if (stderr) {
      const errRl = readline.createInterface({
        input: stderr,
        crlfDelay: Infinity,
      });
      errRl.on('line', (line: string) => {
        console.error('[listener] stderr:', redactListenerLog(line));
        // Detect "another subscriber running" error and stop retrying
        if (line.includes('another event') && line.includes('already running')) {
          console.error('[listener] Another subscriber is running. Killing stale processes and stopping.');
          this.shouldRun = false;
        }
      });
    }

    this.process.on('close', (code: number | null) => {
      console.log(`[listener] lark-cli exited with code ${code}`);
      if (this.shouldRun) {
        this.restartCount += 1;
        console.log(`[listener] Restarting in ${this.restartDelay}ms...`);
        setTimeout(() => {
          this.restartDelay = Math.min(
            this.restartDelay * 2,
            this.maxRestartDelay
          );
          this.spawnProcess();
        }, this.restartDelay);
      } else {
        console.error('[listener] Stopped. Another subscriber may be running. Kill it and restart the daemon.');
      }
    });

    this.process.on('error', (err: Error) => {
      console.error('[listener] Process error:', redactListenerLog(err.message));
    });
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;

    let event: FeishuEvent;
    try {
      event = JSON.parse(trimmed) as FeishuEvent;
    } catch {
      console.error('[listener] Failed to parse NDJSON line:', trimmed.slice(0, 200));
      return;
    }

    if (!MESSAGE_EVENT_TYPES.has(event.header?.event_type)) {
      return;
    }
    this.lastEventAt = Date.now();

    if (
      this.allowedChatIds.length > 0 &&
      !this.allowedChatIds.includes(event.event?.message?.chat_id)
    ) {
      return;
    }

    this.handler(event);
  }
}

export function redactListenerLog(text: string): string {
  return text
    .replace(/([?&](?:access_key|ticket|token|access_token|refresh_token)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(app_secret|appSecret|tenant_access_token|user_access_token)=\S+/gi, '$1=[REDACTED]');
}
