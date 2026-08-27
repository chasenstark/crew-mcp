import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parsePrWatchId } from '../pr-watch/id.js';
import { cancelPrWatch, recordEventDispositions } from '../pr-watch/reducer.js';
import { PrWatchStore } from '../pr-watch/store.js';
import type { PrWatchEventDisposition } from '../pr-watch/types.js';
import { resolveCrewHome } from '../utils/crew-home.js';

export function usage(): string {
  return [
    'Usage: crew-pr-watch <status|history|ack|cancel> <watch_id> [options]',
    '  ack options: --action-batch <id> --dispositions-base64 <base64url-json>',
  ].join('\n');
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const [command, rawWatchId, ...rest] = argv;
  if (!command || !rawWatchId) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const watchId = parsePrWatchId(rawWatchId);
  const store = new PrWatchStore(resolveCrewHome());
  if (!store.exists(watchId)) return 3;
  if (command === 'status') {
    if (rest.length > 0) return 2;
    process.stdout.write(`${JSON.stringify(store.read(watchId).state, null, 2)}\n`);
    return 0;
  }
  if (command === 'history') {
    if (rest.length > 0) return 2;
    process.stdout.write(`${JSON.stringify(store.readHistory(watchId), null, 2)}\n`);
    return 0;
  }
  if (command === 'cancel') {
    if (rest.length > 0) return 2;
    const result = await store.mutate(watchId, (state) => cancelPrWatch(state));
    process.stdout.write(`${JSON.stringify(result.state, null, 2)}\n`);
    return 0;
  }
  if (command === 'ack') {
    const batchIndex = rest.indexOf('--action-batch');
    const dispositionsIndex = rest.indexOf('--dispositions-base64');
    if (batchIndex < 0 || dispositionsIndex < 0) return 2;
    const actionBatchId = rest[batchIndex + 1];
    const encoded = rest[dispositionsIndex + 1];
    if (!actionBatchId || !encoded || rest.length !== 4) return 2;
    const dispositions = parseDispositions(encoded);
    const result = await store.mutate(watchId, (state) => recordEventDispositions(state, {
      actionBatchId,
      dispositions,
    }));
    process.stdout.write(`${JSON.stringify(result.state, null, 2)}\n`);
    return 0;
  }
  return 2;
}

function parseDispositions(
  encoded: string,
): Readonly<Record<string, { readonly disposition: PrWatchEventDisposition; readonly note?: string }>> {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid dispositions encoding');
  const raw = Buffer.from(encoded, 'base64url').toString('utf-8');
  if (Buffer.from(raw).toString('base64url') !== encoded) throw new Error('invalid dispositions encoding');
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('dispositions must be an object');
  }
  const allowed = new Set(['acknowledged', 'superseded', 'deferred', 'resolved']);
  return Object.fromEntries(Object.entries(parsed).map(([eventId, value]) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`invalid disposition for ${eventId}`);
    }
    const candidate = value as { disposition?: unknown; note?: unknown };
    if (typeof candidate.disposition !== 'string' || !allowed.has(candidate.disposition)) {
      throw new Error(`invalid disposition for ${eventId}`);
    }
    if (candidate.note !== undefined && typeof candidate.note !== 'string') {
      throw new Error(`invalid disposition note for ${eventId}`);
    }
    return [eventId, {
      disposition: candidate.disposition as PrWatchEventDisposition,
      ...(candidate.note !== undefined ? { note: candidate.note } : {}),
    }];
  }));
}

if (isInvokedAsCli()) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`crew-pr-watch: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}

function isInvokedAsCli(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
