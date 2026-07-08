import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HealthCheckCache } from '../../src/utils/health-check-cache.js';
import type { HealthCheckResult } from '../../src/adapters/types.js';

describe('HealthCheckCache', () => {
  let tempDir: string;
  let originalCachePath: string | undefined;
  let originalTtl: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'crew-health-cache-'));
    originalCachePath = process.env.CREW_HEALTHCHECK_CACHE_PATH;
    originalTtl = process.env.CREW_HEALTHCHECK_TTL_MS;
    process.env.CREW_HEALTHCHECK_CACHE_PATH = join(tempDir, 'healthcheck-cache.json');
    process.env.CREW_HEALTHCHECK_TTL_MS = '60000';
  });

  afterEach(() => {
    if (originalCachePath === undefined) {
      delete process.env.CREW_HEALTHCHECK_CACHE_PATH;
    } else {
      process.env.CREW_HEALTHCHECK_CACHE_PATH = originalCachePath;
    }
    if (originalTtl === undefined) {
      delete process.env.CREW_HEALTHCHECK_TTL_MS;
    } else {
      process.env.CREW_HEALTHCHECK_TTL_MS = originalTtl;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists a keyed health check result across cache instances', async () => {
    const result: HealthCheckResult = {
      available: true,
      authenticated: true,
      version: 'claude 1.0.12',
    };
    const firstProbe = vi.fn(async () => result);
    const secondProbe = vi.fn(async () => {
      throw new Error('should not probe when persisted cache is valid');
    });

    await new HealthCheckCache().get(undefined, firstProbe, {
      cacheKey: 'claude-code:claude 1.0.12',
      cliVersion: 'claude 1.0.12',
    });
    const cached = await new HealthCheckCache().get(undefined, secondProbe, {
      cacheKey: 'claude-code:claude 1.0.12',
      cliVersion: 'claude 1.0.12',
    });

    expect(cached).toEqual(result);
    expect(firstProbe).toHaveBeenCalledOnce();
    expect(secondProbe).not.toHaveBeenCalled();
  });
});
