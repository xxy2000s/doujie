import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildCodexChatArgs,
  clearCodexSession,
  extractCodexSessionId,
  extractCodexDeltaText,
  extractCodexText,
  isCodexDeltaEvent,
  isAnswerTextDeltaEvent,
  shouldSuppressCompletedDeltaEcho,
  type CodexChatOptions,
} from '../src/ai/codex-chat.js';

const options: CodexChatOptions = {
  model: 'test-model',
  workdir: '/repo',
  sandbox: 'workspace-write',
  skipGitRepoCheck: true,
  sessionKey: 'chat:sender',
};

test('buildCodexChatArgs starts a new codex exec session in configured workdir', () => {
  const args = buildCodexChatArgs('hello', options, null);

  assert.deepEqual(args.slice(0, 2), ['exec', '--json']);
  assert.ok(args.includes('--ignore-user-config'));
  assert.deepEqual(args.slice(args.indexOf('--cd'), args.indexOf('--cd') + 2), ['--cd', '/repo']);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
  assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2), ['--model', 'test-model']);
  assert.ok(args.includes('--skip-git-repo-check'));
  assert.equal(args.at(-1), 'hello');
});

test('buildCodexChatArgs resumes an existing session', () => {
  const args = buildCodexChatArgs('continue', options, 'session-1');

  assert.deepEqual(args.slice(0, 4), ['exec', 'resume', '--json', '--ignore-user-config']);
  assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
  assert.ok(args.includes('session-1'));
  assert.equal(args.at(-1), 'continue');
});

test('buildCodexChatArgs bypasses sandbox for danger-full-access sessions', () => {
  const dangerOptions: CodexChatOptions = {
    ...options,
    sandbox: 'danger-full-access',
  };
  const newSessionArgs = buildCodexChatArgs('hello', dangerOptions, null);
  const resumeArgs = buildCodexChatArgs('continue', dangerOptions, 'session-1');

  assert.ok(newSessionArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(newSessionArgs.includes('--sandbox'), false);
  assert.ok(resumeArgs.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(resumeArgs.includes('--sandbox'), false);
});

test('clearCodexSession removes a saved session key', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doujie-codex-state-'));
  const stateFile = path.join(dir, 'sessions.json');
  try {
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ sessions: { 'chat:sender': 'session-1', other: 'session-2' } }),
      'utf-8'
    );

    assert.equal(clearCodexSession('chat:sender', stateFile), 'session-1');
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf-8')), {
      sessions: { other: 'session-2' },
    });
    assert.equal(clearCodexSession('missing', stateFile), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('extractCodexSessionId reads common event shapes', () => {
  assert.equal(extractCodexSessionId({ thread_id: 't1' }), 't1');
  assert.equal(extractCodexSessionId({ session_id: 's1' }), 's1');
  assert.equal(extractCodexSessionId({ item: { sessionId: 's2' } }), 's2');
  assert.equal(extractCodexSessionId({ type: 'other' }), null);
});

test('extractCodexText reads text from common event shapes and skips noise', () => {
  assert.equal(extractCodexText({ type: 'response.delta', delta: 'hello' }), 'hello');
  assert.equal(extractCodexText({ item: { content: { text: 'nested' } } }), 'nested');
  assert.equal(extractCodexText({ type: 'session.created', text: 'skip' }), '');
  assert.equal(
    extractCodexText({
      item: {
        type: 'error',
        message: 'clamping SessionEnd hook timeout to 3s in /home/example/.codex/hooks.json',
      },
    }),
    ''
  );
});

test('isCodexDeltaEvent identifies top-level and item delta shapes only', () => {
  assert.equal(isCodexDeltaEvent({ type: 'response.delta', delta: 'a' }), true);
  assert.equal(isCodexDeltaEvent({ type: 'item.updated', item: { type: 'text_delta', text: 'b' } }), true);
  assert.equal(isCodexDeltaEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }), false);
});

test('isAnswerTextDeltaEvent excludes reasoning tool and session deltas', () => {
  assert.equal(isAnswerTextDeltaEvent({ delta: 'legacy answer' }), true);
  assert.equal(isAnswerTextDeltaEvent({ type: 'response.output_text.delta', delta: 'answer' }), true);
  assert.equal(isAnswerTextDeltaEvent({ type: 'response.delta', delta: 'answer' }), true);
  assert.equal(isAnswerTextDeltaEvent({ type: 'response.reasoning_summary_text.delta', delta: 'hidden' }), false);
  assert.equal(isAnswerTextDeltaEvent({ type: 'tool.delta', delta: 'hidden' }), false);
  assert.equal(isAnswerTextDeltaEvent({ item: { type: 'command_execution_delta', delta: 'hidden' } }), false);
  assert.equal(isAnswerTextDeltaEvent({ delta: 'hidden', item: { type: 'reasoning_delta' } }), false);
});

test('extractCodexDeltaText preserves whitespace exactly', () => {
  assert.equal(extractCodexDeltaText({ type: 'response.delta', delta: ' world\n' }), ' world\n');
  assert.equal(extractCodexDeltaText({ type: 'response.delta', delta: '\n' }), '\n');
  assert.equal(
    extractCodexDeltaText({ type: 'item.updated', item: { type: 'text_delta', content: { text: '  indented' } } }),
    '  indented'
  );
});

test('shouldSuppressCompletedDeltaEcho removes only matching final agent echoes', () => {
  const completed = { type: 'item.completed', item: { type: 'agent_message', text: 'hello world' } };
  assert.equal(shouldSuppressCompletedDeltaEcho('hello world', completed, 'hello world'), true);
  assert.equal(
    shouldSuppressCompletedDeltaEcho(
      'hello world',
      { type: 'response.output_text.done', text: 'hello world' },
      'hello world'
    ),
    true
  );
  assert.equal(shouldSuppressCompletedDeltaEcho('hello ', completed, 'hello world'), false);
  assert.equal(
    shouldSuppressCompletedDeltaEcho('hello world', { type: 'item.completed', item: { type: 'command_execution' } }, 'hello world'),
    false
  );
  assert.equal(
    shouldSuppressCompletedDeltaEcho(
      'hello world',
      { type: 'response.tool.done', text: 'hello world' },
      'hello world'
    ),
    false
  );
});

test('extractCodexText formats command execution events', () => {
  assert.equal(
    extractCodexText({
      type: 'item.started',
      item: {
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress',
      },
    }),
    '[tool:start command_execution]\n$ /bin/zsh -lc pwd'
  );
  assert.equal(
    extractCodexText({
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        aggregated_output: '/private/tmp\n',
        exit_code: 0,
        status: 'completed',
      },
    }),
    '[tool:done command_execution exit=0]\n$ /bin/zsh -lc pwd\n/private/tmp'
  );
});

test('extractCodexText suppresses detail-only events in answer mode', () => {
  assert.equal(extractCodexText({ type: 'thread.started', thread_id: 'thread-1' }, 'answer'), '');
  assert.equal(extractCodexText({ type: 'turn.started' }, 'answer'), '');
  assert.equal(
    extractCodexText({
      type: 'item.started',
      item: {
        type: 'command_execution',
        command: '/bin/zsh -lc pwd',
        status: 'in_progress',
      },
    }, 'answer'),
    ''
  );
  assert.equal(
    extractCodexText({
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: 'visible answer',
      },
    }, 'answer'),
    'visible answer'
  );
});

test('extractCodexText formats thread and usage events', () => {
  assert.equal(extractCodexText({ type: 'thread.started', thread_id: 'thread-1' }), '[thread] started thread-1');
  assert.equal(
    extractCodexText({
      type: 'turn.completed',
      usage: {
        input_tokens: 10,
        cached_input_tokens: 4,
        output_tokens: 3,
        reasoning_output_tokens: 2,
      },
    }),
    '[turn] completed input=10 cached=4 output=3 reasoning=2'
  );
});
