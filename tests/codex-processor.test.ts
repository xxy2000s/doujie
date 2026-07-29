import assert from 'node:assert/strict';
import os from 'node:os';
import test from 'node:test';
import { buildCodexExecArgs, parseCodexResult } from '../src/ai/codex-processor.js';
import { parseAnswerResult } from '../src/ai/answer-processor.js';

test('buildCodexExecArgs supplies a digest prompt and isolated working directory', () => {
  const args = buildCodexExecArgs('test-model', '/tmp/schema.json');

  assert.deepEqual(args.slice(0, 2), ['exec', '--ephemeral']);
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.deepEqual(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2), ['--cd', os.tmpdir()]);
  assert.deepEqual(
    args.slice(args.indexOf('--output-schema'), args.indexOf('--output-schema') + 2),
    ['--output-schema', '/tmp/schema.json']
  );
  assert.deepEqual(args.slice(args.indexOf('-m'), args.indexOf('-m') + 2), ['-m', 'test-model']);
  assert.match(args[args.length - 1] ?? '', /Analyze only the content provided in the <stdin> block/);
});

test('parseCodexResult parses valid structured output', () => {
  const result = parseCodexResult(JSON.stringify({
    schema_version: 2,
    summary: '1. 要点',
    tags: ['技术', '产品'],
    key_points: ['事实 A'],
    action_items: ['跟进 B'],
    entities: ['InfoHunter'],
    source_type: 'article',
    confidence: 0.9,
  }));

  assert.deepEqual(result, {
    summary: '1. 要点',
    tags: ['技术', '产品'],
    keyPoints: ['事实 A'],
    actionItems: ['跟进 B'],
    entities: ['InfoHunter'],
    sourceType: 'article',
    confidence: 0.9,
    schemaVersion: 2,
  });
});

test('parseCodexResult accepts legacy summary tags output', () => {
  const result = parseCodexResult(JSON.stringify({
    summary: ' summary ',
    tags: ['技术', 123, null, '学习'],
  }));

  assert.deepEqual(result, {
    summary: 'summary',
    tags: ['技术', '学习'],
    keyPoints: [],
    actionItems: [],
    entities: [],
    sourceType: 'unknown',
    confidence: 0,
    schemaVersion: 1,
  });
});

test('parseCodexResult falls back when JSON shape is unexpected', () => {
  const raw = JSON.stringify({ text: 'not schema' });
  const result = parseCodexResult(raw);

  assert.deepEqual(result, {
    summary: raw,
    tags: ['其他'],
    keyPoints: [],
    actionItems: [],
    entities: [],
    sourceType: 'unknown',
    confidence: 0,
    schemaVersion: 0,
  });
});

test('parseCodexResult falls back when output is not JSON', () => {
  const result = parseCodexResult('plain summary');

  assert.deepEqual(result, {
    summary: 'plain summary',
    tags: ['其他'],
    keyPoints: [],
    actionItems: [],
    entities: [],
    sourceType: 'unknown',
    confidence: 0,
    schemaVersion: 0,
  });
});

test('parseCodexResult rejects empty successful output instead of creating fake summaries', () => {
  assert.throws(
    () => parseCodexResult(JSON.stringify({ summary: '   ', tags: ['其他'] })),
    /empty summary/
  );
  assert.throws(
    () => parseCodexResult(''),
    /no output/
  );
});

test('parseAnswerResult parses answer citations and falls back for plain text', () => {
  assert.deepEqual(parseAnswerResult(JSON.stringify({
    answer: 'Use the stored launch checklist.',
    citations: ['msg-1', 123, 'msg-2'],
  })), {
    answer: 'Use the stored launch checklist.',
    citations: ['msg-1', 'msg-2'],
  });

  assert.deepEqual(parseAnswerResult('plain answer'), {
    answer: 'plain answer',
    citations: [],
  });
});
