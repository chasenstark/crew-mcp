import type { AgentAdapter, HealthCheckResult } from './types.js';
import { ClaudeCodeAdapter } from './claude-code.js';
import { CodexAdapter } from './codex.js';

export interface RegistryHealthReport {
  [adapterName: string]: HealthCheckResult;
}

export class AdapterRegistry {
  private adapters = new Map<string, AgentAdapter>();

  constructor() {
    // Pre-register built-in adapters
    this.register(new ClaudeCodeAdapter());
    this.register(new CodexAdapter());
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

/**
 * Default global registry instance.
 */
export const defaultRegistry = new AdapterRegistry();
