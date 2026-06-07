import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withCriteriaLock } from '../../../src/orchestrator/criteria/lock.js';

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('waitFor: timeout');
}

describe('criteria lock', () => {
  let crewHome: string;

  beforeEach(() => {
    crewHome = mkdtempSync(join(tmpdir(), 'crew-criteria-lock-'));
  });

  afterEach(() => {
    rmSync(crewHome, { recursive: true, force: true });
  });

  it('serializes operations for the same criteria id', async () => {
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = withCriteriaLock({ crewHome, criteriaSetId: 'criteria-1' }, async () => {
      order.push('first:start');
      await releaseFirst.promise;
      order.push('first:end');
    });

    await waitFor(() =>
      existsSync(join(crewHome, 'criteria-locks', encodeURIComponent('criteria-1'))));

    const second = withCriteriaLock({ crewHome, criteriaSetId: 'criteria-1' }, async () => {
      order.push('second');
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(['first:start']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
