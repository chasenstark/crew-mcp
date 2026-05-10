import type { HealthCheckOptions, HealthCheckResult } from '../adapters/types.js';

const DEFAULT_SUCCESS_TTL_MS = 30_000;
const FAILURE_TTL_MS = 5_000;

export function healthCheckTtlMs(): number {
  const raw = process.env.CREW_HEALTHCHECK_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUCCESS_TTL_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SUCCESS_TTL_MS;
  return parsed;
}

export class HealthCheckCache {
  private cached?: {
    result: HealthCheckResult;
    expiresAt: number;
  };

  async get(
    options: HealthCheckOptions | undefined,
    probe: () => Promise<HealthCheckResult>,
  ): Promise<HealthCheckResult> {
    const successTtlMs = healthCheckTtlMs();
    const now = Date.now();

    if (!options?.refresh && successTtlMs > 0 && this.cached && this.cached.expiresAt > now) {
      return this.cached.result;
    }

    const result = await probe();
    if (successTtlMs > 0) {
      // Failed probes, including unauthenticated CLIs, are cached briefly to
      // avoid repeated subprocesses while still recovering quickly after
      // install or login.
      const ttlMs = result.available && result.authenticated
        ? successTtlMs
        : Math.min(FAILURE_TTL_MS, successTtlMs);
      this.cached = {
        result,
        expiresAt: now + ttlMs,
      };
    } else {
      this.cached = undefined;
    }

    return result;
  }
}
