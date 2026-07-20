import { z } from 'zod';

import {
  listMessages,
  sweepExpiredMessages,
} from '../captain-inbox/store.js';
import type { CaptainInboxMessage } from '../captain-inbox/schema.js';
import { logger } from '../../utils/logger.js';
import type { ToolCallReturn, ToolHandlerDeps } from './shared.js';
import { markdownContent } from './shared.js';

const inboxStatusFilterSchema = z.enum(['unread', 'read', 'dismissed', 'all']);

export const checkCaptainInboxInputSchema = z.object({
  status: inboxStatusFilterSchema.default('unread'),
  limit: z.number().int().min(1).max(100).default(20),
  since: z.string().datetime({ offset: true }).optional(),
  from_run_id: z.string().optional(),
});

export type CheckCaptainInboxInput = z.infer<typeof checkCaptainInboxInputSchema>;

export const CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS = 300;

export interface CaptainInboxMessageIndexEntry {
  readonly msg_id: string;
  readonly from: CaptainInboxMessage['from'];
  readonly kind: CaptainInboxMessage['kind'];
  readonly status: CaptainInboxMessage['status'];
  readonly created_at: string;
  readonly body_preview: string;
  readonly body_preview_truncated: boolean;
  readonly body_preview_omitted_chars?: number;
}

export interface CheckCaptainInboxOutput {
  readonly messages: readonly (CaptainInboxMessage | CaptainInboxMessageIndexEntry)[];
  readonly message_detail: 'compact' | 'full';
  readonly total_unread: number;
  readonly total_in_inbox: number;
  readonly oldest_unread_at?: string;
}

export const CHECK_CAPTAIN_INBOX_DESCRIPTION =
  'Read the captain inbox for worker send_message results in the current repo, newest-first. Filters: status (default unread), since ISO timestamp, from_run_id, and limit. Unscoped calls return a compact message index with body previews; set from_run_id to retrieve those messages with full bodies in structuredContent. Returns total unread/inbox counts without changing message status. Also opportunistically prunes read/dismissed messages past the retention window.';

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
    .slice(-args.limit)
    .reverse();
  const includeFullBodies = args.from_run_id !== undefined;
  const output: CheckCaptainInboxOutput = {
    messages: includeFullBodies ? messages : messages.map(toMessageIndexEntry),
    message_detail: includeFullBodies ? 'full' : 'compact',
    ...summary,
  };
  return markdownContent(renderCaptainInboxMarkdown(messages, summary, includeFullBodies), output);
}

function toMessageIndexEntry(message: CaptainInboxMessage): CaptainInboxMessageIndexEntry {
  const preview = previewBody(message.body);
  return {
    msg_id: message.msg_id,
    from: message.from,
    kind: message.kind,
    status: message.status,
    created_at: message.created_at,
    body_preview: preview.text,
    body_preview_truncated: preview.omittedChars > 0,
    ...(preview.omittedChars > 0 ? { body_preview_omitted_chars: preview.omittedChars } : {}),
  };
}

function renderCaptainInboxMarkdown(
  messages: readonly CaptainInboxMessage[],
  summary: ReturnType<typeof summarizeMessages>,
  includeFullBodies: boolean,
): string {
  const detail = includeFullBodies
    ? 'Full bodies are in structuredContent.'
    : 'Body previews only; use from_run_id to retrieve full bodies.';
  const lines = [
    `Inbox: ${summary.total_unread} unread / ${summary.total_in_inbox} total. ` +
      `Returned ${messages.length} newest-first. ${detail}`,
  ];
  if (messages.length === 0) {
    lines.push('No messages matched.');
    return lines.join('\n');
  }
  for (const message of messages) {
    const preview = previewBody(message.body);
    const truncation = preview.omittedChars > 0
      ? `… [body_truncated ${preview.omittedChars} chars omitted]`
      : '';
    lines.push(
      `- msg_id=${message.msg_id} from.run_id=${message.from.run_id} ` +
        `agent=${message.from.agent_id} kind=${message.kind} created_at=${message.created_at} ` +
        `status=${message.status} body=${JSON.stringify(`${preview.text}${truncation}`)}`,
    );
  }
  return lines.join('\n');
}

function previewBody(body: string): { readonly text: string; readonly omittedChars: number } {
  const compact = body.replace(/\s+/g, ' ').trim();
  if (compact.length <= CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS) {
    return { text: compact, omittedChars: 0 };
  }
  return {
    text: compact.slice(0, CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS).trimEnd(),
    omittedChars: compact.length - CAPTAIN_INBOX_BODY_PREVIEW_MAX_CHARS,
  };
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
