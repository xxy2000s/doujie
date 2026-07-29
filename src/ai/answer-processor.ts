import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ANSWER_SCHEMA_PATH = path.join(os.tmpdir(), 'doujie-answer-schema.json');
const CODEX_WORKDIR = os.tmpdir();

const ANSWER_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    answer: {
      type: 'string',
      description: 'Answer the user question using only the provided evidence.',
    },
    citations: {
      type: 'array',
      items: { type: 'string' },
      description: 'Stored Doujie memory message ids used as evidence.',
    },
  },
  required: ['answer', 'citations'],
} as const;

let answerSchemaWritten = false;

export type AnswerResult = {
  answer: string;
  citations: string[];
};

function ensureAnswerSchemaFile(): string {
  if (!answerSchemaWritten) {
    fs.writeFileSync(ANSWER_SCHEMA_PATH, JSON.stringify(ANSWER_OUTPUT_SCHEMA), 'utf-8');
    answerSchemaWritten = true;
  }
  return ANSWER_SCHEMA_PATH;
}

export async function processAnswerWithCodex(text: string, model: string): Promise<AnswerResult> {
  const schemaPath = ensureAnswerSchemaFile();
  const args = [
    'exec',
    '--ephemeral',
    '--skip-git-repo-check',
    '--cd', CODEX_WORKDIR,
    '--output-schema', schemaPath,
    '-s', 'read-only',
  ];
  if (model) {
    args.push('-m', model);
  }

  const result = await runCodex(args, text);
  return parseAnswerResult(result);
}

function runCodex(args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('codex', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn codex: ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`codex exited with code ${code}: ${stderr}`));
        return;
      }
      const lines = stdout.trim().split('\n').filter((line) => line.trim());
      resolve(lines[lines.length - 1] ?? '');
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export function parseAnswerResult(raw: string): AnswerResult {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.answer === 'string') {
      return {
        answer: parsed.answer,
        citations: arrayOfStrings(parsed.citations),
      };
    }
    return fallbackAnswer(raw);
  } catch {
    return fallbackAnswer(raw || 'Unable to generate an answer.');
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function fallbackAnswer(answer: string): AnswerResult {
  return { answer, citations: [] };
}
