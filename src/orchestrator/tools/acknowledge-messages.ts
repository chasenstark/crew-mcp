import { z } from 'zod';

import { transitionMessages, type TransitionMessagesResult } from '../captain-inbox/store.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { jsonContent } from './shared.js';

export const acknowledgeMessagesInputSchema = z.object({
  msg_ids: z.array(z.string().min(1)).min(1).max(100),
  action: z.enum(['read', 'dismiss']),
});

export type AcknowledgeMessagesInput = z.infer<typeof acknowledgeMessagesInputSchema>;
export type AcknowledgeMessagesOutput = TransitionMessagesResult;

export const ACKNOWLEDGE_MESSAGES_DESCRIPTION =
  'Mark captain inbox messages in the current repo as read or dismissed by msg_ids. Safe for concurrent calls; returns acknowledged, not_found, and already_in_target_state buckets.';

export async function acknowledgeMessagesToolHandler(
  args: AcknowledgeMessagesInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'projectRoot'>,
): Promise<ToolCallReturn> {
  const result = await transitionMessages({
    crewHome: deps.crewHome,
    repoRoot: deps.projectRoot,
    msgIds: args.msg_ids,
    action: args.action,
  });
  return jsonContent(result);
}
