import type { TaskResult } from './types.js';

export const ARGV_PROMPT_BYTE_LIMIT = 128 * 1024;

export function promptByteLength(prompt: string): number {
  return Buffer.byteLength(prompt, 'utf-8');
}

export function argvPromptTooLargeMessage(
  adapterName: string,
  prompt: string,
  limitBytes = ARGV_PROMPT_BYTE_LIMIT,
): string | undefined {
  const bytes = promptByteLength(prompt);
  if (bytes <= limitBytes) return undefined;
  return `Adapter "${adapterName}" cannot receive this prompt via argv: prompt is ${bytes} bytes, `
    + `above the ${limitBytes} byte argv safety limit. Reduce peer_messages/file excerpts, `
    + 'or use an adapter with stdin prompt transport such as codex or claude-code.';
}

export function argvPromptTooLargeResult(
  adapterName: string,
  prompt: string,
  limitBytes = ARGV_PROMPT_BYTE_LIMIT,
): TaskResult | undefined {
  const message = argvPromptTooLargeMessage(adapterName, prompt, limitBytes);
  if (!message) return undefined;
  return {
    output: message,
    filesModified: [],
    status: 'error',
    metadata: {
      rawEvents: [{ error: message }],
    },
  };
}

export function assertArgvPromptWithinLimit(
  adapterName: string,
  prompt: string,
  limitBytes = ARGV_PROMPT_BYTE_LIMIT,
): void {
  const message = argvPromptTooLargeMessage(adapterName, prompt, limitBytes);
  if (message) throw new Error(message);
}
