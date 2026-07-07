import { z } from 'zod';

export const CAPTAIN_INBOX_SCHEMA_VERSION = 1;

// Matches makeInboxMessageId(): 10-char Crockford-base32 timestamp +
// 16-char random suffix. Alphabet is exactly the store generator's
// CROCKFORD constant: no I, L, O, or U.
export const CAPTAIN_INBOX_MSG_ID_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

export const captainInboxKindSchema = z.enum(['note', 'review', 'question', 'answer', 'status']);
export type CaptainInboxKind = z.infer<typeof captainInboxKindSchema>;

export const captainInboxStatusSchema = z.enum(['unread', 'read', 'dismissed']);
export type CaptainInboxStatus = z.infer<typeof captainInboxStatusSchema>;

export const captainInboxAddressSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('captain') }),
  z.object({
    kind: z.literal('run'),
    run_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
]);
export type CaptainInboxAddress = z.infer<typeof captainInboxAddressSchema>;

export const captainInboxExcerptSchema = z.object({
  file: z.string().min(1),
  range: z.array(z.number().int().min(1)).length(2)
    .refine((range) => range[0] <= range[1], 'range start must be <= end'),
  text: z.string(),
});

export const captainInboxMessageSchema = z.object({
  inbox_schema_version: z.literal(CAPTAIN_INBOX_SCHEMA_VERSION),
  msg_id: z.string().regex(CAPTAIN_INBOX_MSG_ID_REGEX),
  to: z.object({ kind: z.literal('captain') }),
  from: z.object({
    kind: z.literal('run'),
    run_id: z.string().min(1),
    agent_id: z.string().min(1),
  }),
  kind: captainInboxKindSchema,
  body: z.string().min(1),
  body_truncated: z.object({
    original_length: z.number().int().nonnegative(),
  }).optional(),
  files: z.array(z.string()).optional(),
  excerpts: z.array(captainInboxExcerptSchema).optional(),
  status: captainInboxStatusSchema,
  read_at: z.string().datetime({ offset: true }).optional(),
  dismissed_at: z.string().datetime({ offset: true }).optional(),
  created_at: z.string().datetime({ offset: true }),
  worker_run_id_at_send: z.string().min(1),
  worker_agent_id_at_send: z.string().min(1),
  repo_root_at_send: z.string().min(1),
});

export type CaptainInboxMessage = z.infer<typeof captainInboxMessageSchema>;
