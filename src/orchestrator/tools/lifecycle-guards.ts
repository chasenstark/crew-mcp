import { isAbsolute, relative, resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import type { RunStateStore, RunStateV1 } from '../run-state.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

export interface BusyRunGuardArgs {
  readonly targetRun: RunStateV1;
  readonly runStateStore: RunStateStore;
  readonly dispatcher: Pick<ToolDispatcher, 'listInFlight'>;
  readonly includeHostCheckout?: boolean;
  readonly force?: boolean;
}

export function assertNoBusyWorktreeBlockers(args: BusyRunGuardArgs): void {
  if (args.force) return;

  const targetWorktree = normalizePath(args.targetRun.worktreePath);
  const hostRoot = normalizePath(args.runStateStore.repoRoot);
  const blockers: string[] = [];

  for (const inFlight of args.dispatcher.listInFlight()) {
    if (!inFlight.runId || inFlight.runId === args.targetRun.runId) continue;
    const state = args.runStateStore.read(inFlight.runId);
    if (!state || state.status !== 'running') continue;

    const cwd = normalizePath(state.worktreePath);
    const blocksTargetWorktree = isSameOrInside(cwd, targetWorktree);
    const blocksHostCheckout =
      args.includeHostCheckout === true && isSameOrInside(cwd, hostRoot);

    if (blocksTargetWorktree || blocksHostCheckout) {
      blockers.push(`${inFlight.runId}:${cwd}`);
    }
  }

  if (blockers.length === 0) return;

  const action = args.includeHostCheckout === true ? 'merge_run' : 'run lifecycle action';
  throw new Error(
    `busy_worktree: ${action} for ${args.targetRun.runId} refused because live run(s) `
    + `are using paths this operation may mutate: ${blockers.join(', ')}. `
    + 'Wait for them to finish or cancel them before retrying.',
  );
}

function normalizePath(path: string): string {
  const resolved = resolve(path);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isSameOrInside(candidate: string, base: string): boolean {
  const rel = relative(base, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
