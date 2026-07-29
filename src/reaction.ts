import { spawn } from 'node:child_process';
import type { FeishuIdentity } from './types.js';

export type ReactionEmoji = 'THINKING' | 'DONE' | 'ERROR';

export function buildReactionArgs(
  messageId: string,
  emojiType: ReactionEmoji,
  feishuAs: FeishuIdentity
): string[] {
  return [
    'im',
    'reactions',
    'create',
    '--params',
    JSON.stringify({ message_id: messageId }),
    '--data',
    JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
    '--as',
    feishuAs,
  ];
}

export async function addReaction(
  messageId: string,
  emojiType: ReactionEmoji,
  feishuAs: FeishuIdentity = 'bot'
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('lark-cli', buildReactionArgs(messageId, emojiType, feishuAs), {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', (code: number | null) => {
      if (code === 0) {
        console.log('[reaction] Added', emojiType, 'to', messageId);
        resolve();
      } else {
        reject(new Error(`lark-cli exited with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', reject);
  });
}
