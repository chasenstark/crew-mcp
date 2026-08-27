import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  CODEX_THREAD_ID_ENV,
  decodeCodexBridgeFile,
  validateCodexThreadId,
  wakeCodexPrWatchThread,
} from '../codex/app-server-bridge.js';
import { queueCodexPrWatchThread } from '../codex/queue-wake.js';
import { runClaimedCodexPrWatchWake } from '../codex/wake-delivery.js';
import { PrWatchController } from '../pr-watch/controller.js';
import { parsePrWatchId } from '../pr-watch/id.js';
import { SubprocessProviderCommandRunner } from '../pr-watch/provider-runner.js';
import { PrWatchStartIndex } from '../pr-watch/start-index.js';
import { PrWatchStore } from '../pr-watch/store.js';
import { waitForPrWatch, type PrWatchWakeRequest } from '../pr-watch/waiter.js';
import { resolveCrewHome } from '../utils/crew-home.js';

interface ParsedArgs {
  readonly watchId: string;
  readonly generation: number;
  readonly watcherActionId: string;
  readonly crewHome?: string;
  readonly timeoutMs?: number;
  readonly codexBridgeFile?: string;
  readonly codexQueueThreadId?: string;
}

export function usage(): string {
  return 'Usage: crew-pr-watch-wait --watch <watch_id> --generation <n> '
    + '--watcher-action <id> [--crew-home-base64 <base64url>] [--timeout-ms <n>] '
    + '[--codex-bridge-base64 <base64url> | --codex-queue-thread <uuid>]';
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  const crewHome = args.crewHome ?? resolveCrewHome();
  const store = new PrWatchStore(crewHome);
  if (!store.exists(args.watchId)) {
    process.stderr.write(`crew-pr-watch-wait: unknown watch ${args.watchId}\n`);
    return 3;
  }
  const controller = new PrWatchController(
    store,
    new PrWatchStartIndex(crewHome),
    new SubprocessProviderCommandRunner(),
  );
  const transport = args.codexQueueThreadId
    ? 'codex_queue' as const
    : args.codexBridgeFile
      ? 'codex_app_server' as const
      : 'claude_completion' as const;
  const result = await waitForPrWatch({
    store,
    controller,
    watchId: args.watchId,
    generation: args.generation,
    watcherActionId: args.watcherActionId,
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    transport,
    wake: async ({ state }: PrWatchWakeRequest) => {
      const actionBatchId = state.status === 'actionable' ? state.batch.actionBatchId : undefined;
      if (args.codexQueueThreadId) {
        const claimed = await runClaimedCodexPrWatchWake({
          store,
          threadId: args.codexQueueThreadId,
          watchId: state.watchId,
          generation: state.generation,
          startTurn: () => queueCodexPrWatchThread({
            threadId: args.codexQueueThreadId!,
            watchId: state.watchId,
            generation: state.generation,
            status: state.status,
            ...(actionBatchId ? { actionBatchId } : {}),
          }),
        });
        process.stdout.write(claimed.started
          ? `CREW_PR_WATCH_WAKE_QUEUED watch_id=${state.watchId} generation=${state.generation}\n`
          : `CREW_PR_WATCH_WAKE_SKIPPED watch_id=${state.watchId} generation=${state.generation} reason=${claimed.reason}\n`);
        return { started: claimed.started };
      }
      if (args.codexBridgeFile) {
        const threadId = process.env[CODEX_THREAD_ID_ENV] ?? '';
        let claimReason = 'unknown';
        const wake = await wakeCodexPrWatchThread({
          bridgeFile: args.codexBridgeFile,
          threadId,
          watchId: state.watchId,
          generation: state.generation,
          status: state.status,
          ...(actionBatchId ? { actionBatchId } : {}),
          guardTurnStart: async (startTurn) => {
            const claim = await runClaimedCodexPrWatchWake({
              store,
              threadId,
              watchId: state.watchId,
              generation: state.generation,
              startTurn,
            });
            if (!claim.started) {
              claimReason = claim.reason;
              return { action: 'skip' };
            }
            return { action: 'start', result: claim.result };
          },
        });
        process.stdout.write(wake.skipped
          ? `CREW_PR_WATCH_WAKE_SKIPPED watch_id=${state.watchId} generation=${state.generation} reason=${claimReason}\n`
          : `CREW_PR_WATCH_WAKE_SENT watch_id=${state.watchId} generation=${state.generation} turn_id=${wake.turnId}\n`);
        return { started: !wake.skipped };
      }
      process.stdout.write(completionLine(state));
      return { started: true };
    },
  });
  if (result.outcome === 'timeout') {
    process.stdout.write(`CREW_PR_WATCH_TIMEOUT watch_id=${args.watchId} generation=${args.generation}\n`);
  }
  return 0;
}

function completionLine(state: Exclude<PrWatchWakeRequest['state'], { readonly status: 'active' }>): string {
  const batch = state.status === 'actionable' ? ` action_batch_id=${state.batch.actionBatchId}` : '';
  return `CREW_PR_WATCH_${state.status.toUpperCase()} watch_id=${state.watchId} generation=${state.generation}${batch}\n`;
}

function parseArgs(argv: readonly string[]): ParsedArgs | undefined {
  const values = [...argv];
  const take = (flag: string): string | undefined => {
    const index = values.indexOf(flag);
    if (index < 0 || index + 1 >= values.length) return undefined;
    const value = values[index + 1];
    values.splice(index, 2);
    return value;
  };
  try {
    const watchId = parsePrWatchId(take('--watch') ?? '');
    const generation = Number(take('--generation'));
    const watcherActionId = take('--watcher-action');
    if (!Number.isSafeInteger(generation) || generation < 1 || !watcherActionId) return undefined;
    const crewHomeEncoded = take('--crew-home-base64');
    const crewHome = crewHomeEncoded ? decodeBase64Url(crewHomeEncoded) : undefined;
    const timeoutRaw = take('--timeout-ms');
    const timeoutMs = timeoutRaw === undefined ? undefined : Number(timeoutRaw);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)) return undefined;
    const bridgeEncoded = take('--codex-bridge-base64');
    const codexBridgeFile = bridgeEncoded ? decodeCodexBridgeFile(bridgeEncoded) : undefined;
    const codexQueueThreadId = take('--codex-queue-thread');
    if (codexQueueThreadId) validateCodexThreadId(codexQueueThreadId);
    if (codexBridgeFile && codexQueueThreadId) return undefined;
    if (values.length > 0) return undefined;
    return {
      watchId,
      generation,
      watcherActionId,
      ...(crewHome ? { crewHome } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(codexBridgeFile ? { codexBridgeFile } : {}),
      ...(codexQueueThreadId ? { codexQueueThreadId } : {}),
    };
  } catch {
    return undefined;
  }
}

function decodeBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const decoded = Buffer.from(value, 'base64url').toString('utf-8');
  if (!decoded || Buffer.from(decoded).toString('base64url') !== value) throw new Error('invalid base64url');
  return decoded;
}

if (isInvokedAsCli()) {
  main().then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      process.stderr.write(`crew-pr-watch-wait: ${error instanceof Error ? error.message : String(error)}\n`);
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
