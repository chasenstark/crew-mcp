import { z } from 'zod';

import {
  listMessages,
  sweepExpiredMessages,
} from '../captain-inbox/store.js';
import type { CaptainInboxMessage } from '../captain-inbox/schema.js';
import { logger } from '../../utils/logger.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { jsonContent } from './shared.js';

const inboxStatusFilterSchema = z.enum(['unread', 'read', 'dismissed', 'all']);

export const checkCaptainInboxInputSchema = z.object({
  status: inboxStatusFilterSchema.default('unread'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().datetime({ offset: true }).optional(),
  from_run_id: z.string().optional(),
});

export type CheckCaptainInboxInput = z.infer<typeof checkCaptainInboxInputSchema>;

export interface CheckCaptainInboxOutput {
  readonly messages: readonly CaptainInboxMessage[];
  readonly total_unread: number;
  readonly total_in_inbox: number;
  readonly oldest_unread_at?: string;
}

export const CHECK_CAPTAIN_INBOX_DESCRIPTION =
  'Read the captain inbox for worker send_message results in the current repo. Filters: status (default unread), since ISO timestamp, from_run_id, and limit. Returns chronological messages plus total unread/inbox counts without changing message status. Also opportunistically prunes read/dismissed messages past the retention window.';

export async function checkCaptainInboxToolHandler(
  args: CheckCaptainInboxInput,
  deps: Pick<ToolHandlerDeps, 'crewHome' | 'projectRoot'>,
): Promise<ToolCallReturn> {
  // Fire-and-forget so a stale inbox write lock cannot block or fail the
  // read path. The current call serves the pre-sweep snapshot; later reads
  // catch up after the cooldown-controlled sweeper succeeds.
  void sweepExpiredMessages({
    crewHome: deps.crewHome,
    repoRoot: deps.projectRoot,
  }).catch((err) => {
    logger.warn(
      `captain inbox sweep: failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  const allMessages = listMessages({ crewHome: deps.crewHome, repoRoot: deps.projectRoot });
  const summary = summarizeMessages(allMessages);
  const sinceMs = args.since !== undefined ? Date.parse(args.since) : undefined;
  const messages = allMessages
    .filter((message) => matchesStatus(message, args.status))
    .filter((message) => sinceMs === undefined || Date.parse(message.created_at) >= sinceMs)
    .filter((message) => args.from_run_id === undefined || message.from.run_id === args.from_run_id)
    .slice(0, args.limit);
  return jsonContent({ messages, ...summary });
}

function matchesStatus(message: CaptainInboxMessage, status: CheckCaptainInboxInput['status']): boolean {
  return status === 'all' || message.status === status;
}

function summarizeMessages(messages: readonly CaptainInboxMessage[]): {
  readonly total_unread: number;
  readonly total_in_inbox: number;
  readonly oldest_unread_at?: string;
} {
  let totalUnread = 0;
  let oldestUnreadAt: string | undefined;
  let oldestUnreadMs = Number.POSITIVE_INFINITY;
  for (const message of messages) {
    if (message.status !== 'unread') continue;
    totalUnread += 1;
    const createdAtMs = Date.parse(message.created_at);
    if (createdAtMs < oldestUnreadMs) {
      oldestUnreadMs = createdAtMs;
      oldestUnreadAt = message.created_at;
    }
  }
  return {
    total_unread: totalUnread,
    total_in_inbox: messages.length,
    ...(oldestUnreadAt !== undefined ? { oldest_unread_at: oldestUnreadAt } : {}),
  };
}
