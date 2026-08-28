import { sha256Canonical } from '../../src/pr-watch/canonical.js';
import type { PrWatchController } from '../../src/pr-watch/controller.js';
import { makePrWatchId, makePrWatchTransactionId } from '../../src/pr-watch/id.js';
import { createInitialPrWatchState, markPrWatchTerminal } from '../../src/pr-watch/reducer.js';
import { PrWatchStore } from '../../src/pr-watch/store.js';
import { waitForPrWatch } from '../../src/pr-watch/waiter.js';

async function main(): Promise<void> {
  const crewHome = process.env.CREW_PR_WATCH_TEST_HOME;
  if (!crewHome) throw new Error('CREW_PR_WATCH_TEST_HOME is required');
  const store = new PrWatchStore(crewHome);
  const watchId = makePrWatchId();
  const initial = createInitialPrWatchState({
    watchId,
    initialization: {
      repository: 'example/repo',
      anchorPrNumber: 42,
      repoRoot: '/tmp/example',
      effectiveConfig: {
        maxPrs: 50,
        maxActionableWakes: 20,
        maxActionRounds: 5,
        maxWatchAgeDays: -1,
        policyHash: sha256Canonical({ mode: 'github_rules' }),
      },
      expectedHeads: { '42': 'abc123' },
    },
  });
  await store.create(initial, makePrWatchTransactionId());
  let polls = 0;
  let wakes = 0;
  const controller = {
    pollOnce: async () => {
      polls += 1;
      process.stdout.write(`POLL ${polls}\n`);
      if (polls === 1) return { state: store.read(watchId).state, queried: true };
      const terminal = await store.mutate(watchId, (state) => markPrWatchTerminal(state, {
        outcome: 'green',
        fingerprint: 'subprocess-lifetime-terminal',
      }));
      return { state: terminal.state, queried: true };
    },
  } as PrWatchController;
  const result = await waitForPrWatch({
    store,
    controller,
    watchId,
    generation: initial.generation,
    watcherActionId: initial.waiter.watcherActionId,
    pollIntervalMs: 25,
    leaseMs: 60_000,
    heartbeatIntervalMs: 1_000,
    transport: 'codex_queue',
    wake: async ({ state }) => {
      wakes += 1;
      process.stdout.write(`WAKE ${state.status}\n`);
      return { started: true };
    },
  });
  process.stdout.write(`RESULT ${JSON.stringify({
    watchId,
    polls,
    wakes,
    outcome: result.outcome,
  })}\n`);
}

void main().then(
  () => { process.exitCode = 0; },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
