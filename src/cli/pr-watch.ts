import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parsePrWatchId } from '../pr-watch/id.js';
import { PrWatchEffectController } from '../pr-watch/effect-controller.js';
import { SubprocessProviderCommandRunner } from '../pr-watch/provider-runner.js';
import { cancelPrWatch, recordEventDispositions } from '../pr-watch/reducer.js';
import { PrWatchStore } from '../pr-watch/store.js';
import type { PrWatchEffectKind, PrWatchEventDisposition } from '../pr-watch/types.js';
import { resolveCrewHome } from '../utils/crew-home.js';

export function usage(): string {
  return [
    'Usage: crew-pr-watch <status|history|ack|cancel|effect> <watch_id> [options]',
    '  ack options: --action-batch <id> --dispositions-base64 <base64url-json>',
    '  effect options: --generation <n> --action-batch <id> --event <id>',
    '    --kind <effect-kind> --target-base64 <base64url-json> [--body-base64 <base64url>]',
    '    [--disposition <resolved|deferred|acknowledged|superseded>]',
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
  if (command === 'effect') {
    const options = parseFlagValues(rest);
    const generation = Number(options.get('--generation'));
    const actionBatchId = options.get('--action-batch');
    const eventId = options.get('--event');
    const kind = options.get('--kind');
    const targetEncoded = options.get('--target-base64');
    if (
      !Number.isSafeInteger(generation)
      || generation < 1
      || !actionBatchId
      || !eventId
      || !kind
      || !targetEncoded
      || !isEffectKind(kind)
    ) return 2;
    const disposition = options.get('--disposition');
    if (disposition !== undefined && !isDisposition(disposition)) return 2;
    const bodyEncoded = options.get('--body-base64');
    const controller = new PrWatchEffectController(
      store,
      new SubprocessProviderCommandRunner(),
    );
    const result = await controller.execute({
      watchId,
      expectedGeneration: generation,
      actionBatchId,
      eventId,
      kind,
      target: parseEffectTarget(targetEncoded),
      ...(bodyEncoded !== undefined ? { body: decodeBase64Url(bodyEncoded, 64 * 1024) } : {}),
      ...(disposition !== undefined ? { disposition } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }
  return 2;
}

function parseFlagValues(values: readonly string[]): ReadonlyMap<string, string> {
  if (values.length % 2 !== 0) throw new Error('effect flags require values');
  const result = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const flag = values[index];
    const value = values[index + 1];
    if (!flag.startsWith('--') || result.has(flag)) throw new Error(`invalid effect flag ${flag}`);
    result.set(flag, value);
  }
  const allowed = new Set([
    '--generation', '--action-batch', '--event', '--kind', '--target-base64',
    '--body-base64', '--disposition',
  ]);
  for (const flag of result.keys()) {
    if (!allowed.has(flag)) throw new Error(`unknown effect flag ${flag}`);
  }
  return result;
}

function parseEffectTarget(encoded: string): Readonly<Record<string, string | number>> {
  const parsed = JSON.parse(decodeBase64Url(encoded, 8 * 1024)) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('effect target must be an object');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 10) throw new Error('invalid effect target size');
  for (const [key, value] of entries) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key)) throw new Error('invalid effect target key');
    if (
      !(
        (typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\0\r\n]/.test(value))
        || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
      )
    ) throw new Error(`invalid effect target ${key}`);
  }
  return parsed as Readonly<Record<string, string | number>>;
}

function decodeBase64Url(encoded: string, maxBytes: number): string {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid base64url');
  const bytes = Buffer.from(encoded, 'base64url');
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64url') !== encoded) {
    throw new Error('invalid base64url');
  }
  return bytes.toString('utf-8');
}

function isEffectKind(value: string): value is PrWatchEffectKind {
  return [
    'push_single_branch',
    'reply_review_comment',
    'post_pr_comment',
    'resolve_review_thread',
  ].includes(value);
}

function isDisposition(value: string): value is PrWatchEventDisposition {
  return ['acknowledged', 'superseded', 'deferred', 'resolved'].includes(value);
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
