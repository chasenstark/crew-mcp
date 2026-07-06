import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  issueRunAuthSidecar,
  readRunAuthSidecar,
  revokeRunAuthSidecar,
  runAuthSidecarPath,
  validateRunAuthSidecar,
} from '../../../src/orchestrator/auth/index.js';

describe('run auth sidecars', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length > 0) cleanups.pop()?.();
  });

  function makeDirs(): { crewHome: string; repoRoot: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'crew-auth-'));
    const crewHome = join(root, '.crew');
    const repoRoot = join(root, 'repo');
    writeFileSync(join(root, 'placeholder'), 'x', 'utf-8');
    // mkdir via issueRunAuthSidecar handles crewHome/runs; repo root must exist.
    writeFileSync(repoRoot, '', 'utf-8');
    return {
      crewHome,
      repoRoot,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  }

  it('issues and verifies a token round trip with a 0600 sidecar', () => {
    const h = makeDirs();
    cleanups.push(h.cleanup);

    const issued = issueRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-1',
      agentId: 'codex',
      repoRoot: h.repoRoot,
      captainServeInstance: 'serve-1',
      writeMode: 'must-not-exist',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });

    expect(issued.dispatchMcpEnv).toEqual({
      CREW_RUN_ID: 'run-1',
      CREW_RUN_TOKEN: issued.sidecar.token,
    });
    const validated = validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-1',
      token: issued.sidecar.token,
      now: new Date('2026-01-01T00:00:01.000Z'),
    });
    expect(validated.agent_id).toBe('codex');
    expect(readRunAuthSidecar(h.crewHome, 'run-1').token).toBe(issued.sidecar.token);
  });

  it('rejects absent, tampered, expired, and revoked tokens', () => {
    const h = makeDirs();
    cleanups.push(h.cleanup);

    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'missing',
      token: '0'.repeat(64),
    })).toThrow(/sidecar_missing/);

    const issued = issueRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-2',
      agentId: 'codex',
      repoRoot: h.repoRoot,
      captainServeInstance: 'serve-1',
      writeMode: 'must-not-exist',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-2',
      token: 'f'.repeat(64),
      now: new Date('2026-01-01T00:00:01.000Z'),
    })).toThrow(/token_invalid/);
    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-2',
      token: issued.sidecar.token,
      now: new Date('2026-01-01T00:00:02.000Z'),
      tokenTtlMs: 1,
    })).toThrow(/token_expired/);

    revokeRunAuthSidecar(h.crewHome, 'run-2', new Date('2026-01-01T00:00:03.000Z'));
    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-2',
      token: issued.sidecar.token,
      now: new Date('2026-01-01T00:00:04.000Z'),
    })).toThrow(/token_revoked/);
  });

  it('rejects sidecars with unsafe permissions', () => {
    const h = makeDirs();
    cleanups.push(h.cleanup);
    const issued = issueRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-3',
      agentId: 'codex',
      repoRoot: h.repoRoot,
      captainServeInstance: 'serve-1',
      writeMode: 'must-not-exist',
    });
    const path = runAuthSidecarPath(h.crewHome, 'run-3');
    const raw = readFileSync(path, 'utf-8');
    chmodSync(path, 0o644);
    writeFileSync(path, raw, 'utf-8');
    chmodSync(path, 0o644);

    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId: 'run-3',
      token: issued.sidecar.token,
    })).toThrow(/sidecar_permission_invalid/);
  });

  it.each([
    '../escape',
    '/tmp/evil',
    'escape/child',
    'escape\\child',
    '.hidden',
  ])('rejects unsafe run id %j before resolving a sidecar path', (runId) => {
    const h = makeDirs();
    cleanups.push(h.cleanup);

    expect(() => validateRunAuthSidecar({
      crewHome: h.crewHome,
      runId,
      token: '0'.repeat(64),
    })).toThrow(/run_id_invalid/);
  });
});
