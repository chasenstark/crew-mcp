import { z } from 'zod';

export const PEER_MESSAGES_SCHEMA_VERSION = 1;

export const peerMessageInputSchema = z.object({
  body: z.string().min(1),
  kind: z.enum(['note', 'review', 'question', 'answer', 'status']).default('note'),
  from_label: z.string().max(80).optional()
    .refine(
      (s) => !s || !/[\x00-\x1f\x7f`#\r\n]/.test(s),
      'no control chars, backticks, newlines, or # in from_label',
    ),
  files: z.array(z.string().max(4096)).max(1000).optional(),
  excerpts: z.array(z.object({
    file: z.string().max(4096),
    range: z.tuple([z.number().int().min(1), z.number().int().min(1)]),
    text: z.string(),
  })).max(1000).optional(),
});

export const peerMessagesInputSchema = z.array(peerMessageInputSchema).max(10000);

export type PeerMessageInput = z.infer<typeof peerMessageInputSchema>;

export interface PeerMessageRendered {
  readonly peer_messages_schema_version: 1;
  readonly body: string;
  readonly kind: 'note' | 'review' | 'question' | 'answer' | 'status';
  readonly from_label?: string;
  readonly files?: readonly string[];
  readonly excerpts?: ReadonlyArray<{
    readonly file: string;
    readonly range: readonly [number, number];
    readonly text: string;
  }>;
  readonly rendered_at: string;
  readonly rendered_in_turn: number;
  readonly body_truncated?: { readonly original_length: number };
  readonly excerpt_truncations?: ReadonlyArray<{
    readonly index: number;
    readonly original_length: number;
  }>;
}
