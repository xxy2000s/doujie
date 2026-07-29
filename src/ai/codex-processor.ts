import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AIResult } from '../types.js';

const SCHEMA_PATH = path.join(os.tmpdir(), 'doujie-schema.json');
const CODEX_WORKDIR = os.tmpdir();
const DIGEST_PROMPT = [
  'You are Doujie, a local control-plane assistant that turns captured Feishu messages into searchable notes.',
  'Analyze only the content provided in the <stdin> block.',
  'Return JSON that matches the output schema exactly.',
  'The summary must be non-empty Chinese, concise, and useful for later retrieval.',
  'Use numbered bullet points when the content contains multiple ideas.',
  'Choose tags only from: 技术, 产品, 设计, 商业, 学习, 生活, 想法, 待办, 资讯, 其他.',
  'Use source_type values such as chat, article, link, file, image, or unknown.',
  'If the input is short, still summarize the concrete meaning instead of returning an empty summary.',
].join('\n');

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schema_version: { type: 'number', description: '输出 schema 版本，固定为 2' },
    summary: { type: 'string', description: '用简洁的中文总结内容要点，3-5个要点，用编号列表格式' },
    tags: {
      type: 'array',
      items: { type: 'string' },
      description: '分类标签，从以下选择：技术、产品、设计、商业、学习、生活、想法、待办、资讯、其他',
    },
    key_points: {
      type: 'array',
      items: { type: 'string' },
      description: '3-5 个可检索的关键事实或观点，短句',
    },
    action_items: {
      type: 'array',
      items: { type: 'string' },
      description: '明确的待办或后续行动，没有则为空数组',
    },
    entities: {
      type: 'array',
      items: { type: 'string' },
      description: '人名、组织、产品、地点、技术名词等实体，没有则为空数组',
    },
    source_type: {
      type: 'string',
      description: '来源类型，例如 article、chat、link、file、image、unknown',
    },
    confidence: {
      type: 'number',
      description: '0 到 1 的置信度',
    },
  },
  required: ['schema_version', 'summary', 'tags', 'key_points', 'action_items', 'entities', 'source_type', 'confidence'],
} as const;

let schemaWritten = false;

function ensureSchemaFile(): string {
  if (!schemaWritten) {
    fs.writeFileSync(SCHEMA_PATH, JSON.stringify(OUTPUT_SCHEMA), 'utf-8');
    schemaWritten = true;
  }
  return SCHEMA_PATH;
}

export async function processWithCodex(text: string, model: string): Promise<AIResult> {
  const schemaPath = ensureSchemaFile();
  const args = buildCodexExecArgs(model, schemaPath);

  const result = await runCodex(args, text);
  return parseCodexResult(result);
}

export function buildCodexExecArgs(model: string, schemaPath: string): string[] {
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
  args.push(DIGEST_PROMPT);
  return args;
}

export async function processWithCodexRetry(
  text: string,
  model: string
): Promise<AIResult> {
  try {
    return await processWithCodex(text, model);
  } catch (err) {
    console.error('[codex] First attempt failed:', (err as Error).message);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return await processWithCodex(text, model);
  }
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
      // Extract the last non-empty line (the actual output, ignoring JSONL events)
      const lines = stdout.trim().split('\n').filter((l) => l.trim());
      const lastLine = lines[lines.length - 1] || '';
      resolve(lastLine);
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

export function parseCodexResult(raw: string): AIResult {
  try {
    // If --json flag produces JSONL, find the last JSON object
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.summary === 'string' && Array.isArray(parsed.tags)) {
      const summary = parsed.summary.trim();
      if (!summary) {
        throw new Error('codex returned an empty summary');
      }
      return {
        summary,
        tags: normalizeTags(parsed.tags),
        keyPoints: arrayOfStrings(parsed.key_points),
        actionItems: arrayOfStrings(parsed.action_items),
        entities: arrayOfStrings(parsed.entities),
        sourceType: typeof parsed.source_type === 'string' ? parsed.source_type : 'unknown',
        confidence: normalizeConfidence(parsed.confidence),
        schemaVersion: typeof parsed.schema_version === 'number' ? parsed.schema_version : 1,
      };
    }
    console.error('[codex] Unexpected output shape:', raw);
    return fallbackResult(raw);
  } catch (err) {
    if ((err as Error).message === 'codex returned an empty summary') {
      throw err;
    }
    console.error('[codex] Failed to parse output:', raw);
    if (!raw.trim()) {
      throw new Error('codex returned no output');
    }
    return fallbackResult(raw);
  }
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function normalizeTags(value: unknown[]): string[] {
  const tags = value
    .filter((item): item is string => typeof item === 'string')
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length > 0 ? tags : ['其他'];
}

function fallbackResult(summary: string): AIResult {
  return {
    summary,
    tags: ['其他'],
    keyPoints: [],
    actionItems: [],
    entities: [],
    sourceType: 'unknown',
    confidence: 0,
    schemaVersion: 0,
  };
}
