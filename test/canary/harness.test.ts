import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { issueRunAuthSidecar } from '../../src/orchestrator/auth/token.js';
import { listMessages } from '../../src/orchestrator/captain-inbox/store.js';
import {
  CANARY_HOSTS,
  formatCanaryReport,
  provisionSandbox,
  runStubWorker,
  selectAndAdvanceHost,
  WAKE_BRIDGE_CAVEAT,
  writeCanaryReport,
  type CanaryReport,
} from '../../src/canary/harness.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('canary host rotation', () => {
  it('persists, advances, and wraps from claude-code', () => {
    const root = tempRoot();
    const statePath = join(root, 'state', 'rotation.json');
    const selected = CANARY_HOSTS.map(() => selectAndAdvanceHost(statePath));
    expect(selected.map((item) => item.host)).toEqual(['claude-code', 'codex', 'agy']);
    expect(selectAndAdvanceHost(statePath)).toEqual({
      host: 'claude-code',
      nextHost: 'codex',
    });
  });
});

describe('canary report', () => {
  const report: CanaryReport = {
    generatedAt: '2026-07-23T12:00:00.000Z',
    host: 'claude-code',
    nextHost: 'codex',
    trialsPerScenario: 2,
    launcherNote: 'wired test launcher',
    trials: [
      { scenarioId: 'dispatch-and-watch', status: 'PASS', detail: 'watch observed' },
      { scenarioId: 'dispatch-and-watch', status: 'FAIL', detail: 'status missing' },
      { scenarioId: 'skipped-inbox', status: 'SKIPPED', detail: 'quota-limited' },
      { scenarioId: 'skipped-inbox', status: 'SKIPPED', detail: 'quota-limited' },
      { scenarioId: 'stale-read-only-regression', status: 'PASS', detail: 'no nudge' },
      { scenarioId: 'stale-read-only-regression', status: 'PASS', detail: 'no nudge' },
    ],
  };

  it('formats trend-only pass@k, rotation, skips, and wake-bridge caveat', () => {
    const markdown = formatCanaryReport(report);
    expect(markdown).toContain('TREND signal only');
    expect(markdown).toContain('never a PR or merge gate');
    expect(markdown).toContain('`claude-code` (persisted rotation; next: `codex`)');
    expect(markdown).toContain('| dispatch-and-watch | 1/2 |');
    expect(markdown).toContain('| skipped-inbox | 0/2 (2 skipped) |');
    expect(markdown).toContain(WAKE_BRIDGE_CAVEAT);
  });

  it('writes to an injected temporary report path', () => {
    const path = join(tempRoot(), 'status', 'canary.md');
    writeCanaryReport(path, report);
    expect(readFileSync(path, 'utf-8')).toBe(formatCanaryReport(report));
  });
});

describe('canary GenericAdapter stub workers', () => {
  it('writes a deterministic fixture edit', async () => {
    const cwd = tempRoot();
    await runStubWorker('write', { cwd });
    expect(readFileSync(join(cwd, 'canary-stub.txt'), 'utf-8'))
      .toBe('deterministic canary edit\n');
  });

  it('calls the production send_message handler with the run sidecar', async () => {
    const root = tempRoot();
    const crewHome = join(root, 'crew-home');
    const repoRoot = join(root, 'repo');
    const runId = 'canary-message-run';
    const cwd = join(crewHome, 'runs', runId, 'worktree');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    await issueRunAuthSidecar({
      crewHome,
      runId,
      agentId: 'canary-stub-message',
      repoRoot,
      captainServeInstance: 'canary-test',
      writeMode: 'must-not-exist',
    });

    await runStubWorker('message', { cwd, crewHome });

    expect(existsSync(join(crewHome, 'captain-inbox'))).toBe(true);
    expect(listMessages({ crewHome, repoRoot }))
      .toContainEqual(expect.objectContaining({
        body: 'Deterministic canary worker message.',
        worker_run_id_at_send: runId,
      }));
  });
});

describe('canary sandbox provisioning', () => {
  it('removes its temp root when provisioning throws before returning', async () => {
    let createdRoot = '';
    await expect(provisionSandbox('/unused', {
      afterRootCreated: (root) => {
        createdRoot = root;
        throw new Error('injected provisioning failure');
      },
    })).rejects.toThrow('injected provisioning failure');
    expect(createdRoot).not.toBe('');
    expect(existsSync(createdRoot)).toBe(false);
  });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'crew-canary-test-'));
  roots.push(root);
  return root;
}
