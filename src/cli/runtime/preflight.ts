import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../../adapters/types.js';
import { AgentId } from '../../workflow/agents.js';
import type { FullConfig } from '../../workflow/types.js';
import { resolveCaptainModel } from '../../workflow/config-codec.js';
import { logger } from '../../utils/logger.js';
import { CatalogLock } from '../../captain/catalog-lock.js';
import {
  hashGeminiSettings,
  toGeminiMcpSettings,
  type ToolCatalog as McpToolCatalog,
} from '../../captain/mcp-registration.js';
import { atomicWrite } from '../../utils/atomic-write.js';

interface AdapterLookup {
  get(name: string): AgentAdapter | undefined;
}

interface PreflightFailure {
  agentName: string;
  isCaptain: boolean;
  reason: string;
}

export function collectRequiredAgentNames(config: FullConfig): string[] {
  const required = new Set<string>();

  required.add(config.captain.cli);

  for (const configuredAgent of Object.keys(config.agents)) {
    required.add(configuredAgent);
  }

  for (const step of config.workflow.steps) {
    if (step.agent && step.agent !== AgentId.CAPTAIN) {
      required.add(step.agent);
    }
  }

  return [...required];
}

let crewCodexConfigWarned = false;

/**
 * Exported for tests only; lets a test reset the "warned once" latch so each
 * test observes the deprecation path cleanly.
 */
export function __resetPreflightWarningLatchForTest(): void {
  crewCodexConfigWarned = false;
}

/**
 * Emits the CREW_CODEX_CONFIG deprecation notice once per process if set.
 * The env var is honored nowhere after M0.5-2; we still read it so the
 * user learns the flag they set is ignored, rather than silently.
 */
export function checkCrewCodexConfigDeprecation(): void {
  const value = process.env.CREW_CODEX_CONFIG?.trim();
  if (!value) return;
  if (crewCodexConfigWarned) return;
  logger.warn(
    `[preflight] CREW_CODEX_CONFIG is set to "${value}" but is no longer honored. ` +
      'Per-session Codex overrides are now driven by the captain tool registry; ' +
      'remove the env var or migrate to `codex -p <profile>`.',
  );
  crewCodexConfigWarned = true;
}

/**
 * If the resolved captain model is set but the captain adapter doesn't
 * recognize it, log a warning and clear the value so the captain falls back
 * to its built-in default. Returns the pre-warn value for test assertions.
 */
export function enforceCaptainModelCompatibility(
  config: FullConfig,
  captainAdapter: AgentAdapter,
): { warnedModel?: string } {
  const resolved = resolveCaptainModel(config.captain);
  if (!resolved) return {};

  // Adapters without recognizesModel pass through unchanged.
  if (typeof captainAdapter.recognizesModel !== 'function') return {};

  if (captainAdapter.recognizesModel(resolved)) return {};

  logger.warn(
    `[preflight] captain.model "${resolved}" is not recognized by captain.cli "${config.captain.cli}". ` +
      'Falling back to the captain CLI default for this run.',
  );
  // Clear the effective model so downstream code sees undefined and lets
  // the adapter's default kick in.
  if (typeof config.captain.model === 'string') {
    config.captain.model = undefined;
  } else if (config.captain.model && typeof config.captain.model === 'object') {
    const key = config.captain.cli as keyof typeof config.captain.model;
    delete config.captain.model[key];
  }
  return { warnedModel: resolved };
}

/**
 * Where the Gemini settings.json file should live. Respects the
 * `GEMINI_HOME_OVERRIDE` env var so tests + sandboxed runs point at a
 * writable tmp dir instead of `$HOME/.gemini/`. Production callers rarely
 * pass it.
 *
 * Returns `{ dir, settingsPath }` so callers can ensure the directory and
 * hand the file path to atomicWrite.
 */
export function resolveGeminiSettingsPath(
  options: { homeOverride?: string } = {},
): { dir: string; settingsPath: string } {
  const home = options.homeOverride ?? process.env.GEMINI_HOME_OVERRIDE ?? join(homedir(), '.gemini');
  return { dir: home, settingsPath: join(home, 'settings.json') };
}

/**
 * M3-9: for captains that consume a file-based settings.json (currently
 * only Gemini), regenerate the file iff the catalog hash has drifted from
 * the lockfile.
 *
 * Returns a small summary so tests and telemetry can distinguish the three
 * outcomes without observing the filesystem directly.
 */
export function syncGeminiSettingsFromCatalog(args: {
  projectRoot: string;
  captainCliName: string;
  catalog: McpToolCatalog;
  homeOverride?: string;
}): { action: 'skipped-not-gemini' | 'skipped-match' | 'written'; hash?: string; settingsPath?: string } {
  if (args.captainCliName !== 'gemini-cli') {
    return { action: 'skipped-not-gemini' };
  }

  const hash = hashGeminiSettings(args.catalog);
  const stored = CatalogLock.loadHash(args.projectRoot);
  const { dir, settingsPath } = resolveGeminiSettingsPath({ homeOverride: args.homeOverride });

  if (stored === hash && existsSync(settingsPath)) {
    // No-op when the lockfile matches AND the settings file is present on
    // disk (covers the case where a user deletes settings.json manually).
    return { action: 'skipped-match', hash, settingsPath };
  }

  const { settingsJson } = toGeminiMcpSettings(args.catalog);
  mkdirSync(dir, { recursive: true });
  // Gemini reads the file as plain JSON; the official format allows other
  // top-level keys we don't manage, so merge rather than overwrite.
  const existing = readExistingGeminiSettings(settingsPath);
  const merged = { ...existing, ...settingsJson };
  atomicWrite(settingsPath, JSON.stringify(merged, null, 2));
  CatalogLock.writeHash(args.projectRoot, hash);
  return { action: 'written', hash, settingsPath };
}

function readExistingGeminiSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    // Non-object top-level JSON (array, primitive) — treat as malformed
    // rather than merging onto {}. Same warn path as a parse error.
    logger.warn(
      `[preflight] ${path} is not a JSON object; overwriting with catalog-derived content. Prior content may have been lost.`,
    );
  } catch (err: unknown) {
    logger.warn(
      `[preflight] ${path} is malformed; overwriting with catalog-derived content. Prior content may have been lost. (parse error: ${err instanceof Error ? err.message : String(err)})`,
    );
  }
  return {};
}

export async function assertRequiredAgentsReady(
  registry: AdapterLookup,
  config: FullConfig,
): Promise<void> {
  // The sync sweep (CREW_CODEX_CONFIG deprecation + captain-model compat
  // fallback) is performed inside createRunner so the runner captures the
  // mutated model. Re-running it here is idempotent — the deprecation latch
  // ensures we don't warn twice — so it's safe for callers that build their
  // own registries without going through createRunner.
  checkCrewCodexConfigDeprecation();

  const captainAdapter = registry.get(config.captain.cli);
  if (captainAdapter) {
    enforceCaptainModelCompatibility(config, captainAdapter);
  }

  const requiredAgents = collectRequiredAgentNames(config);

  const failures = (
    await Promise.all(
      requiredAgents.map(async (agentName): Promise<PreflightFailure | null> => {
        const adapter = registry.get(agentName);
        const isCaptain = agentName === config.captain.cli;

        if (!adapter) {
          return {
            agentName,
            isCaptain,
            reason: 'adapter is not registered',
          };
        }

        try {
          const health = await adapter.healthCheck();
          if (!health.available) {
            return {
              agentName,
              isCaptain,
              reason: health.error
                ? `unavailable: ${health.error}`
                : 'unavailable',
            };
          }

          if (!health.authenticated) {
            return {
              agentName,
              isCaptain,
              reason: health.error
                ? `not authenticated: ${health.error}`
                : 'not authenticated',
            };
          }
        } catch (error: unknown) {
          return {
            agentName,
            isCaptain,
            reason: error instanceof Error
              ? `health check failed: ${error.message}`
              : `health check failed: ${String(error)}`,
          };
        }

        return null;
      }),
    )
  ).filter((failure): failure is PreflightFailure => failure !== null);

  if (failures.length === 0) return;

  const detailLines = failures.map((failure) => {
    const label = failure.isCaptain
      ? `${failure.agentName} (captain)`
      : failure.agentName;
    return `- ${label}: ${failure.reason}`;
  });

  throw new Error([
    'Preflight checks failed. Required adapters are not ready:',
    ...detailLines,
    'Run `crew status` and authenticate missing providers before running the workflow.',
  ].join('\n'));
}
