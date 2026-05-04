import type { AgentAdapter, AgentStrength, HealthCheckResult } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';
import { GeminiCliAdapter } from './gemini-cli.js';
import { GenericAdapter } from './generic.js';
import { OpenAiCompatibleAdapter } from './openai-compatible.js';
import type { AgentConfig } from '../workflow/types.js';
import { AdapterId } from '../workflow/agents.js';

export interface RegistryHealthReport {
  [adapterName: string]: HealthCheckResult;
}

export class AdapterRegistry {
  /** Maps adapter `name` (canonical id) → adapter. */
  private adapters = new Map<string, AgentAdapter>();
  /**
   * Maps alias → canonical adapter name. Lookups via `get` / `getOrThrow`
   * fall through to this map when the requested key isn't a canonical
   * name. Kept separate from `adapters` so `listAvailable()` doesn't
   * surface the same adapter once per alias.
   */
  private aliasToName = new Map<string, string>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.name) || this.aliasToName.has(adapter.name)) {
      throw new Error(
        `Adapter id "${adapter.name}" collides with an existing registration.`,
      );
    }
    for (const alias of adapter.aliases ?? []) {
      if (this.adapters.has(alias) || this.aliasToName.has(alias)) {
        throw new Error(
          `Alias "${alias}" for adapter "${adapter.name}" collides with an existing registration.`,
        );
      }
    }
    this.adapters.set(adapter.name, adapter);
    for (const alias of adapter.aliases ?? []) {
      this.aliasToName.set(alias, adapter.name);
    }
  }

  get(name: string): AgentAdapter | undefined {
    const direct = this.adapters.get(name);
    if (direct) return direct;
    const canonical = this.aliasToName.get(name);
    return canonical ? this.adapters.get(canonical) : undefined;
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.get(name);
    if (!adapter) {
      const known = [...this.adapters.keys(), ...this.aliasToName.keys()];
      throw new Error(
        `Adapter "${name}" not found. Available adapters: ${known.join(', ')}`,
      );
    }
    return adapter;
  }

  async healthCheckAll(): Promise<RegistryHealthReport> {
    const report: RegistryHealthReport = {};
    const entries = [...this.adapters.entries()];

    const results = await Promise.allSettled(
      entries.map(([, adapter]) => adapter.healthCheck()),
    );

    for (let i = 0; i < entries.length; i++) {
      const [name] = entries[i];
      const result = results[i];

      if (result.status === 'fulfilled') {
        report[name] = result.value;
      } else {
        report[name] = {
          available: false,
          authenticated: false,
          error:
            result.reason instanceof Error
              ? result.reason.message
              : 'Health check failed',
        };
      }
    }

    return report;
  }

  listAvailable(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}

/**
 * Normalize strength strings from agent config: trim, lowercase, dedupe,
 * preserve input order. Strengths are always free-form — no enum gate.
 * Empty input → empty array (adapter ships its own defaults; users can
 * override via ~/.crew/strengths.json post-install, see strengths/store).
 */
function toStrengths(config: AgentConfig): AgentStrength[] {
  const candidates = config.strengths ?? [];
  const seen = new Set<string>();
  const normalized: AgentStrength[] = [];
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim().toLowerCase();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function createRegistryFromConfig(
  agents: Record<string, AgentConfig>,
): AdapterRegistry {
  const registry = new AdapterRegistry();

  for (const [name, config] of Object.entries(agents)) {
    const adapterType = config.adapter ?? name;

    if (adapterType === AdapterId.GENERIC) {
      if (!config.command) {
        throw new Error(
          `Agent "${name}" uses adapter "${AdapterId.GENERIC}" but no command is configured.`,
        );
      }

      registry.register(
        new GenericAdapter({
          name,
          command: config.command,
          argsTemplate: config.args ?? ['{{prompt}}'],
          strengths: toStrengths(config),
        }),
      );
      continue;
    }

    if (adapterType === AdapterId.OPENAI_COMPATIBLE) {
      registry.register(
        new OpenAiCompatibleAdapter({
          name,
          model: config.model,
          apiBase: config.apiBase,
          apiKey: config.apiKey,
          strengths: toStrengths(config),
        }),
      );
      continue;
    }

    if (
      adapterType === AdapterId.CLAUDE_CODE
      || adapterType === AdapterId.CODEX
      || adapterType === AdapterId.GEMINI_CLI
    ) {
      if (name !== adapterType) {
        throw new Error(
          `Built-in adapter "${adapterType}" must be configured under key "${adapterType}" (received "${name}").`,
        );
      }
      registry.register(createBuiltinAdapter(adapterType));
      continue;
    }

    throw new Error(
      `Unsupported adapter "${adapterType}" for agent "${name}".`,
    );
  }

  return registry;
}

function createBuiltinAdapter(adapterType: AdapterId): AgentAdapter {
  switch (adapterType) {
    case AdapterId.CLAUDE_CODE:
      return new ClaudeCodeAdapter();
    case AdapterId.CODEX:
      return new CodexAdapter();
    case AdapterId.GEMINI_CLI:
      return new GeminiCliAdapter();
    default:
      throw new Error(`"${adapterType}" is not a built-in adapter.`);
  }
}

export function createBuiltinRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new ClaudeCodeAdapter());
  registry.register(new CodexAdapter());
  registry.register(new GeminiCliAdapter());
  return registry;
}
