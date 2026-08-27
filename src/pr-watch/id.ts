import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const PR_WATCH_ID_PATTERN = /^pw-[0-9a-f]{32}$/;
export const PR_WATCH_OPAQUE_ID_PATTERN = /^pws-[0-9a-f]{32}$/;

export function makePrWatchId(): string {
  return `pw-${randomBytes(16).toString('hex')}`;
}

export function parsePrWatchId(value: string): string {
  if (!PR_WATCH_ID_PATTERN.test(value)) {
    throw new Error(
      'pr_watch.invalid_watch_id: expected a server-issued pw- followed by 32 lowercase hex characters',
    );
  }
  return value;
}

export function makePrWatchSurfaceId(): string {
  return `pws-${randomBytes(16).toString('hex')}`;
}

export function parsePrWatchSurfaceId(value: string): string {
  if (!PR_WATCH_OPAQUE_ID_PATTERN.test(value)) {
    throw new Error('pr_watch.invalid_surface_id');
  }
  return value;
}

export function makePrWatchTransactionId(): string {
  return randomUUID();
}

export function hashPrWatchStartKey(args: {
  readonly repoRoot: string;
  readonly idempotencyKey: string;
}): string {
  if (args.idempotencyKey.length === 0 || Buffer.byteLength(args.idempotencyKey, 'utf-8') > 512) {
    throw new Error('pr_watch.invalid_idempotency_key');
  }
  return createHash('sha256')
    .update(JSON.stringify({ repoRoot: args.repoRoot, idempotencyKey: args.idempotencyKey }))
    .digest('hex');
}
