import { execa } from 'execa';

import { codexSafeSpawnEnvironment } from '../codex/environment.js';
import type { ModelDescriptor } from './types.js';

export interface AgyModelDiscoveryResult {
  readonly ok: boolean;
  readonly models: readonly ModelDescriptor[];
  readonly reason?: string;
}

/** Parse `agy models`: `<provider-id>\t<exact --model label>`. */
export function parseAgyModels(output: string): ModelDescriptor[] {
  const seenLabels = new Set<string>();
  const models: ModelDescriptor[] = [];
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const providerId = line.slice(0, tab).trim();
    const label = line.slice(tab + 1).trim();
    if (!providerId || !label || seenLabels.has(label)) continue;
    seenLabels.add(label);
    models.push({ model: label, displayName: label, providerId });
  }
  return models;
}

export async function discoverAgyModels(): Promise<AgyModelDiscoveryResult> {
  try {
    const result = await execa('agy', ['models'], {
      ...codexSafeSpawnEnvironment(),
      timeout: 15_000,
      reject: false,
      stdin: 'ignore',
    });
    if (result.exitCode !== 0) {
      return {
        ok: false,
        models: [],
        reason: `${result.stderr || result.stdout || `agy models exited ${result.exitCode}`}`.trim(),
      };
    }
    const models = parseAgyModels(result.stdout ?? '');
    if (models.length === 0) {
      return {
        ok: false,
        models: [],
        reason: 'agy models returned no tab-separated model rows',
      };
    }
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      models: [],
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
