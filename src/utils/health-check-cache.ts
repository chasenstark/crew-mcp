import type { HealthCheckOptions, HealthCheckResult } from '../adapters/types.js';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Success TTL: probes are expensive (claude's is a real LLM round-trip) and
// availability rarely flips outside a deliberate login/logout, so successes
// cache for 5 minutes; a stale "available" self-corrects at dispatch time
// with a classified auth failure. Failures stay short so a fresh login is
// picked up quickly. Override via CREW_HEALTHCHECK_TTL_MS.
const DEFAULT_SUCCESS_TTL_MS = 5 * 60_000;
const FAILURE_TTL_MS = 5_000;
const CACHE_SCHEMA_VERSION = 1;

export function healthCheckTtlMs(): number {
  const raw = process.env.CREW_HEALTHCHECK_TTL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_SUCCESS_TTL_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_SUCCESS_TTL_MS;
  return parsed;
}

interface PersistentHealthCheckCacheEntry {
  readonly result: HealthCheckResult;
  readonly expiresAt: number;
  readonly cliVersion: string;
}

interface PersistentHealthCheckCacheFile {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly entries: Record<string, PersistentHealthCheckCacheEntry>;
}

export interface PersistentHealthCheckCacheOptions {
  readonly cacheKey: string;
  readonly cliVersion: string;
}

export class HealthCheckCache {
  private cached?: {
    result: HealthCheckResult;
    expiresAt: number;
    cacheKey?: string;
    cliVersion?: string;
  };

  async get(
    options: HealthCheckOptions | undefined,
    probe: () => Promise<HealthCheckResult>,
    persistent?: PersistentHealthCheckCacheOptions,
  ): Promise<HealthCheckResult> {
    const successTtlMs = healthCheckTtlMs();
    const now = Date.now();

    if (
      !options?.refresh
      && successTtlMs > 0
      && this.cached
      && this.cached.expiresAt > now
      && (
        persistent === undefined
          ? this.cached.cacheKey === undefined
          : this.cached.cacheKey === persistent.cacheKey && this.cached.cliVersion === persistent.cliVersion
      )
    ) {
      return this.cached.result;
    }
    if (!options?.refresh && successTtlMs > 0 && persistent !== undefined) {
      const persisted = await readPersistentHealthCheck(persistent.cacheKey, now);
      if (persisted !== undefined && persisted.cliVersion === persistent.cliVersion) {
        this.cached = {
          result: persisted.result,
          expiresAt: persisted.expiresAt,
          cacheKey: persistent.cacheKey,
          cliVersion: persistent.cliVersion,
        };
        return persisted.result;
      }
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
        ...(persistent !== undefined
          ? { cacheKey: persistent.cacheKey, cliVersion: persistent.cliVersion }
          : {}),
      };
      if (persistent !== undefined) {
        await writePersistentHealthCheck(persistent.cacheKey, {
          result,
          expiresAt: now + ttlMs,
          cliVersion: persistent.cliVersion,
        }).catch(() => undefined);
      }
    } else {
      this.cached = undefined;
    }

    return result;
  }
}

export function healthCheckCachePath(): string {
  return process.env.CREW_HEALTHCHECK_CACHE_PATH
    ?? join(homedir(), '.crew', 'healthcheck-cache.json');
}

async function readPersistentHealthCheck(
  cacheKey: string,
  now: number,
): Promise<PersistentHealthCheckCacheEntry | undefined> {
  let parsed: PersistentHealthCheckCacheFile;
  try {
    parsed = JSON.parse(await readFile(healthCheckCachePath(), 'utf-8')) as PersistentHealthCheckCacheFile;
  } catch {
    return undefined;
  }
  if (parsed.schemaVersion !== CACHE_SCHEMA_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
    return undefined;
  }
  const entry = parsed.entries[cacheKey];
  if (!entry || entry.expiresAt <= now) return undefined;
  return entry;
}

async function writePersistentHealthCheck(
  cacheKey: string,
  entry: PersistentHealthCheckCacheEntry,
): Promise<void> {
  const path = healthCheckCachePath();
  const dir = dirname(path);
  let current: PersistentHealthCheckCacheFile = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: {},
  };
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as PersistentHealthCheckCacheFile;
    if (parsed.schemaVersion === CACHE_SCHEMA_VERSION && parsed.entries && typeof parsed.entries === 'object') {
      current = parsed;
    }
  } catch {
    // Missing or corrupt cache files are replaced atomically below.
  }
  const next: PersistentHealthCheckCacheFile = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    entries: {
      ...current.entries,
      [cacheKey]: entry,
    },
  };
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.healthcheck-cache.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf-8');
  await rename(tmp, path);
}
