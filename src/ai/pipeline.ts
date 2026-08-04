import type { AIResult } from '../types.js';
import { processWithCodexRetry } from './codex-processor.js';

const DEFAULT_MAX_CONCURRENCY = 1;
const DEFAULT_MAX_INPUT_CHARS = 60000;
export const INPUT_TRUNCATED_MARKER = '\n\n[Doujie: input truncated]';

export type AIProcessor = (text: string, model: string) => Promise<AIResult>;

type QueueJob = {
  text: string;
  model: string;
  resolve(result: AIResult): void;
  reject(error: unknown): void;
};

export type AIPipelineOptions = {
  maxConcurrency?: number;
  maxInputChars?: number;
  processor?: AIProcessor;
};

export function truncateForCodex(
  text: string,
  maxInputChars: number = DEFAULT_MAX_INPUT_CHARS
): string {
  if (text.length <= maxInputChars) {
    return text;
  }
  if (maxInputChars <= INPUT_TRUNCATED_MARKER.length) {
    return INPUT_TRUNCATED_MARKER.slice(0, Math.max(0, maxInputChars));
  }
  const keepChars = maxInputChars - INPUT_TRUNCATED_MARKER.length;
  return `${text.slice(0, keepChars)}${INPUT_TRUNCATED_MARKER}`;
}

export class AIPipeline {
  private model: string;
  private maxConcurrency: number;
  private maxInputChars: number;
  private processor: AIProcessor;
  private activeCount = 0;
  private queue: QueueJob[] = [];

  constructor(model: string, options: AIPipelineOptions = {}) {
    this.model = model;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY));
    this.maxInputChars = options.maxInputChars ?? DEFAULT_MAX_INPUT_CHARS;
    this.processor = options.processor ?? processWithCodexRetry;
  }

  async process(text: string, model: string = this.model): Promise<AIResult> {
    const governedText = truncateForCodex(text, this.maxInputChars);
    return new Promise<AIResult>((resolve, reject) => {
      this.queue.push({ text: governedText, model, resolve, reject });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    while (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job) return;
      this.activeCount += 1;
      void this.runJob(job);
    }
  }

  private async runJob(job: QueueJob): Promise<void> {
    try {
      console.log('[ai] Starting pipeline for text length:', job.text.length);
      const result = await this.processor(job.text, job.model);
      console.log('[ai] Pipeline complete. Tags:', result.tags);
      job.resolve(result);
    } catch (err) {
      job.reject(err);
    } finally {
      this.activeCount -= 1;
      this.drainQueue();
    }
  }
}
