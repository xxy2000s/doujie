import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIPipeline,
  INPUT_TRUNCATED_MARKER,
  truncateForCodex,
  type AIProcessor,
} from '../src/ai/pipeline.js';
import { AnswerPipeline, type AnswerProcessor } from '../src/ai/answer-pipeline.js';
import type { AIResult } from '../src/types.js';
import { aiResult } from './helpers.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('AIPipeline limits concurrent processor calls', async () => {
  let active = 0;
  let maxActive = 0;
  const processor: AIProcessor = async (text: string): Promise<AIResult> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(5);
    active -= 1;
    return aiResult({ summary: text, tags: ['技术'] });
  };
  const pipeline = new AIPipeline('test-model', {
    maxConcurrency: 2,
    processor,
  });

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) => pipeline.process(`job-${index}`))
  );

  assert.equal(maxActive, 2);
  assert.equal(results.length, 20);
});

test('AIPipeline starts queued calls in FIFO order', async () => {
  const started: string[] = [];
  const processor: AIProcessor = async (text: string): Promise<AIResult> => {
    started.push(text);
    return aiResult({ summary: text, tags: ['技术'] });
  };
  const pipeline = new AIPipeline('test-model', {
    maxConcurrency: 1,
    processor,
  });

  const results = await Promise.all([
    pipeline.process('first'),
    pipeline.process('second'),
    pipeline.process('third'),
  ]);

  assert.deepEqual(started, ['first', 'second', 'third']);
  assert.deepEqual(results.map((result) => result.summary), ['first', 'second', 'third']);
});

test('truncateForCodex caps long input with a visible marker', () => {
  const result = truncateForCodex('x'.repeat(100), 40);

  assert.equal(result.length, 40);
  assert.ok(result.endsWith(INPUT_TRUNCATED_MARKER));
});

test('AIPipeline truncates input before processing', async () => {
  let processedText = '';
  const processor: AIProcessor = async (text: string): Promise<AIResult> => {
    processedText = text;
    return aiResult({ summary: 'ok', tags: ['技术'] });
  };
  const pipeline = new AIPipeline('test-model', {
    maxInputChars: 40,
    processor,
  });

  await pipeline.process('x'.repeat(100));

  assert.equal(processedText.length, 40);
  assert.ok(processedText.endsWith(INPUT_TRUNCATED_MARKER));
});

test('AIPipeline propagates processor errors and continues draining', async () => {
  const processor: AIProcessor = async (text: string): Promise<AIResult> => {
    if (text === 'bad') {
      throw new Error('processor failed');
    }
    return aiResult({ summary: text, tags: ['技术'] });
  };
  const pipeline = new AIPipeline('test-model', {
    maxConcurrency: 1,
    processor,
  });

  const results = await Promise.allSettled([
    pipeline.process('bad'),
    pipeline.process('good'),
  ]);

  assert.equal(results[0]?.status, 'rejected');
  assert.equal(results[1]?.status, 'fulfilled');
  if (results[1]?.status === 'fulfilled') {
    assert.equal(results[1].value.summary, 'good');
  }
});

test('AnswerPipeline truncates Q&A input before processing', async () => {
  let processedText = '';
  const processor: AnswerProcessor = async (text: string) => {
    processedText = text;
    return { answer: 'ok', citations: ['msg-1'] };
  };
  const pipeline = new AnswerPipeline('test-model', {
    maxInputChars: 40,
    processor,
  });

  await pipeline.answer('x'.repeat(100));

  assert.equal(processedText.length, 40);
  assert.ok(processedText.endsWith(INPUT_TRUNCATED_MARKER));
});
