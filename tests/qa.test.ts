import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAskPrompt,
  formatAskAnswer,
  formatNoEvidenceAnswer,
  normalizeCitations,
  type AskEvidence,
} from '../src/qa.js';

const evidence: AskEvidence[] = [
  {
    id: 'msg-1',
    content: 'Launch checklist content',
    summary: 'Launch checklist summary',
    tags: '["技术","待办"]',
    keyPoints: '["fact one"]',
    actionItems: '["ship it"]',
    entities: '["InfoHunter"]',
    sourceType: 'chat',
    confidence: 0.9,
    schemaVersion: 2,
    sources: 'example.com',
    receivedAt: Date.parse('2026-01-01T00:00:00.000Z'),
  },
  {
    id: 'msg-2',
    content: 'Other content',
    summary: null,
    tags: null,
    keyPoints: null,
    actionItems: null,
    entities: null,
    sourceType: null,
    confidence: null,
    schemaVersion: null,
    sources: null,
    receivedAt: Date.parse('2026-01-02T00:00:00.000Z'),
  },
];

test('buildAskPrompt includes question structured evidence and citation rules', () => {
  const prompt = buildAskPrompt('What should ship?', evidence);

  assert.match(prompt, /Question: What should ship\?/);
  assert.match(prompt, /Every factual claim must be supported/);
  assert.match(prompt, /message_id: msg-1/);
  assert.match(prompt, /summary: Launch checklist summary/);
  assert.match(prompt, /key_points: fact one/);
  assert.match(prompt, /sources: example.com/);
});

test('formatAskAnswer filters citations and falls back to evidence id', () => {
  assert.deepEqual(normalizeCitations(['msg-2', 'unknown', 'msg-2'], evidence), ['msg-2']);
  assert.deepEqual(normalizeCitations([], evidence), ['msg-1']);

  const reply = formatAskAnswer('What should ship?', { answer: 'Ship the checklist.', citations: [] }, evidence);
  assert.match(reply, /Ship the checklist/);
  assert.match(reply, /References:/);
  assert.match(reply, /msg-1/);
});

test('formatNoEvidenceAnswer refuses to invent answers', () => {
  assert.match(formatNoEvidenceAnswer('Unknown?'), /No evidence found/);
  assert.match(formatNoEvidenceAnswer('Unknown?'), /will not invent/);
});
