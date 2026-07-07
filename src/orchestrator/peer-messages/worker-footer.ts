import type { AgentAdapter } from '../../adapters/types.js';

export const WORKER_SEND_MESSAGE_FOOTER = `## Reporting back to the captain

You have access to the \`send_message\` tool. Use it to deliver
structured findings to the captain. Required: \`body\`. Optional:
\`kind\` (note / review / question / answer / status), \`files\`,
\`excerpts\`.

Call \`send_message\` once you have a finalized result to deliver.
Do NOT call it for in-progress status updates unless the captain has
explicitly asked.`;

const TIER_2_ADAPTERS = new Set(['codex', 'claude-code']);

export function isTier2WorkerAdapter(adapter: Pick<AgentAdapter, 'name'>): boolean {
  return TIER_2_ADAPTERS.has(adapter.name);
}

export function appendWorkerFooterForAdapter(
  prompt: string,
  adapter: Pick<AgentAdapter, 'name'>,
): string {
  if (!isTier2WorkerAdapter(adapter)) return prompt;
  return `${prompt}\n\n${WORKER_SEND_MESSAGE_FOOTER}`;
}
