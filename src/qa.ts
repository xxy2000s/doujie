import type { AnswerResult } from './ai/answer-processor.js';
import type { SearchMessageResult, Store } from './store.js';

export const DEFAULT_ASK_EVIDENCE_LIMIT = 8;

export type AskEvidence = SearchMessageResult;

export function getAskEvidence(
  store: Store,
  question: string,
  limit: number = DEFAULT_ASK_EVIDENCE_LIMIT,
  excludeMessageId?: string
): AskEvidence[] {
  const rows = searchEvidence(store, question, limit, excludeMessageId);
  if (rows.length > 0) return rows;

  const normalizedQuestion = normalizeQuestionKeyword(question);
  if (normalizedQuestion && normalizedQuestion !== question.trim()) {
    return searchEvidence(store, normalizedQuestion, limit, excludeMessageId);
  }
  return [];
}

function searchEvidence(
  store: Store,
  keyword: string,
  limit: number,
  excludeMessageId?: string
): AskEvidence[] {
  return store.searchMessages({ keyword, limit: limit + 1 }, limit + 1, 20)
    .filter((row) => row.id !== excludeMessageId)
    .slice(0, limit);
}

function normalizeQuestionKeyword(question: string): string {
  return question
    .replace(/[?!？！，。；;：:、,.()[\]{}"'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildAskPrompt(question: string, evidence: AskEvidence[]): string {
  const lines = [
    '[Doujie QA]',
    '',
    'Answer the user question using only the evidence records below.',
    'If the evidence is insufficient, say that the stored messages do not contain enough evidence.',
    'Every factual claim must be supported by at least one message_id from the evidence.',
    'Return JSON that matches the requested schema.',
    '',
    `Question: ${question}`,
    '',
    'Evidence:',
  ];

  evidence.forEach((row, index) => {
    lines.push(
      '',
      `[${index + 1}]`,
      `message_id: ${row.id}`,
      `received_at: ${new Date(row.receivedAt).toISOString()}`,
      `sources: ${row.sources ?? '(none)'}`,
      `tags: ${formatJsonArray(row.tags)}`,
      `summary: ${row.summary ?? '(none)'}`,
      `key_points: ${formatJsonArray(row.keyPoints)}`,
      `action_items: ${formatJsonArray(row.actionItems)}`,
      `entities: ${formatJsonArray(row.entities)}`,
      `content: ${row.content}`
    );
  });

  return lines.join('\n');
}

export function formatAskAnswer(question: string, result: AnswerResult, evidence: AskEvidence[]): string {
  const citations = normalizeCitations(result.citations, evidence);
  const references = citations
    .map((messageId) => {
      const row = evidence.find((item) => item.id === messageId);
      const date = row ? new Date(row.receivedAt).toLocaleString() : 'unknown time';
      const sources = row?.sources ? `, sources: ${row.sources}` : '';
      return `- ${messageId} (${date}${sources})`;
    })
    .join('\n');

  return [
    `Answer for: ${question}`,
    '',
    result.answer.trim() || 'The stored messages do not contain enough evidence to answer this question.',
    '',
    'References:',
    references || '- (no stored message citation)',
  ].join('\n');
}

export function formatNoEvidenceAnswer(question: string): string {
  return `No evidence found for: ${question}\n\nI did not find stored messages that match this question, so I will not invent an answer.`;
}

export function normalizeCitations(citations: string[], evidence: AskEvidence[]): string[] {
  const evidenceIds = new Set(evidence.map((row) => row.id));
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (!evidenceIds.has(citation) || seen.has(citation)) continue;
    seen.add(citation);
    normalized.push(citation);
  }
  if (normalized.length === 0 && evidence.length > 0) {
    normalized.push(evidence[0].id);
  }
  return normalized;
}

function formatJsonArray(raw: string | null): string {
  const values = parseJsonArray(raw);
  return values.length > 0 ? values.join(', ') : '(none)';
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
