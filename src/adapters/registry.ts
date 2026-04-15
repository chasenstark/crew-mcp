import type { AgentAdapter, AgentCapability, HealthCheckResult } from './types.js';
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
  private adapters = new Map<string, AgentAdapter>();

  constructor() {
    // Pre-register built-in adapters
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
    this.register(new GeminiCliAdapter());
  }

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.name, adapter);
  }

  get(name: string): AgentAdapter | undefined {
    return this.adapters.get(name);
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.adapters.get(name);
    if (!adapter) {
      throw new Error(
        `Adapter "${name}" not found. Available adapters: ${[...this.adapters.keys()].join(', ')}`,
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

const VALID_CAPABILITIES: AgentCapability[] = [
  'implement',
  'review',
  'refactor',
  'test',
  'document',
  'analyze',
];

function toCapabilities(config: AgentConfig): AgentCapability[] {
  const candidates = config.capabilities ?? config.strengths ?? [];
  const normalized = candidates
    .map((value) => value.trim().toLowerCase())
    .filter((value): value is AgentCapability =>
      (VALID_CAPABILITIES as string[]).includes(value),
    );

  if (normalized.length > 0) return normalized;
  return ['analyze'];
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
          capabilities: toCapabilities(config),
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
          capabilities: toCapabilities(config),
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
      continue;
    }

    throw new Error(
      `Unsupported adapter "${adapterType}" for agent "${name}".`,
    );
  }

  return registry;
}

/**
 * Default global registry instance.
 */
export const defaultRegistry = new AdapterRegistry();
