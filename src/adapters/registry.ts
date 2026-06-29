import type {
  AgentAdapter,
  AgentStrength,
  CaptainCapabilities,
  EffortLevel,
  HealthCheckResult,
} from './types.js';
import type { AgentConfig } from '../workflow/types.js';
import { AdapterId } from '../workflow/agents.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';
import { isLoopbackApiBase, resolveOpenAiApiBase } from './unmetered.js';

export interface RegistryHealthReport {
  [adapterName: string]: HealthCheckResult;
}

type BuiltinAdapterId =
  | AdapterId.CLAUDE_CODE
  | AdapterId.CODEX
  | AdapterId.GEMINI_CLI;

export const BUILTIN_ADAPTER_NAMES: readonly BuiltinAdapterId[] = [
  AdapterId.CLAUDE_CODE,
  AdapterId.CODEX,
  AdapterId.GEMINI_CLI,
];

interface LazyAdapterMetadata {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly strengths: readonly AgentStrength[];
  readonly useWhen?: string;
  readonly defaultEffort?: EffortLevel;
  readonly supportsJsonSchema: boolean;
  readonly enforcesReadOnly: boolean;
  readonly unmetered?: boolean;
  readonly captainCapabilities?: CaptainCapabilities;
  readonly recognizesModel?: (modelId: string) => boolean;
  readonly hasExecuteWithSchema?: boolean;
  readonly hasExecuteWithTools?: boolean;
  readonly hasGetCliVersionTag?: boolean;
}

type LazyAdapterLoader = () => Promise<AgentAdapter>;

interface AdapterEntry {
  readonly name: string;
  readonly aliases?: readonly string[];
  adapter?: AgentAdapter;
  readonly proxy: AgentAdapter;
  readonly loader?: LazyAdapterLoader;
  loadPromise?: Promise<AgentAdapter>;
}

const CAPTAIN_TOOL_LOOP_CAPABILITIES: CaptainCapabilities = {
  supportsToolLoop: true,
  supportsStructuredDecisions: true,
  supportsPauseForUserInput: true,
};

const GENERIC_CAPABILITIES: CaptainCapabilities = {
  supportsToolLoop: false,
  supportsStructuredDecisions: true,
  supportsPauseForUserInput: false,
};

const BUILTIN_ADAPTER_METADATA: Record<BuiltinAdapterId, LazyAdapterMetadata> = {
  [AdapterId.CLAUDE_CODE]: {
    name: AdapterId.CLAUDE_CODE,
    aliases: ['claude'],
    strengths: BUILTIN_AGENT_ROUTING[AdapterId.CLAUDE_CODE].strengths,
    useWhen: BUILTIN_AGENT_ROUTING[AdapterId.CLAUDE_CODE].useWhen,
    supportsJsonSchema: true,
    enforcesReadOnly: false,
    captainCapabilities: CAPTAIN_TOOL_LOOP_CAPABILITIES,
    recognizesModel: (modelId) =>
      typeof modelId === 'string'
      && (/^claude-/.test(modelId) || modelId === 'sonnet' || modelId === 'opus'),
    hasExecuteWithSchema: true,
    hasExecuteWithTools: true,
    hasGetCliVersionTag: true,
  },
  [AdapterId.CODEX]: {
    name: AdapterId.CODEX,
    strengths: BUILTIN_AGENT_ROUTING[AdapterId.CODEX].strengths,
    useWhen: BUILTIN_AGENT_ROUTING[AdapterId.CODEX].useWhen,
    defaultEffort: 'medium',
    supportsJsonSchema: true,
    enforcesReadOnly: true,
    captainCapabilities: CAPTAIN_TOOL_LOOP_CAPABILITIES,
    recognizesModel: (modelId) =>
      typeof modelId === 'string' && /^(gpt-|o\d)/.test(modelId),
    hasExecuteWithSchema: true,
    hasExecuteWithTools: true,
    hasGetCliVersionTag: true,
  },
  [AdapterId.GEMINI_CLI]: {
    name: AdapterId.GEMINI_CLI,
    strengths: BUILTIN_AGENT_ROUTING[AdapterId.GEMINI_CLI].strengths,
    useWhen: BUILTIN_AGENT_ROUTING[AdapterId.GEMINI_CLI].useWhen,
    supportsJsonSchema: false,
    enforcesReadOnly: false,
    captainCapabilities: CAPTAIN_TOOL_LOOP_CAPABILITIES,
    recognizesModel: (modelId) =>
      typeof modelId === 'string' && /^(gemini|qwen)/i.test(modelId),
    hasExecuteWithSchema: true,
    hasExecuteWithTools: true,
    hasGetCliVersionTag: true,
  },
};

export class AdapterRegistry {
  /** Maps adapter `name` (canonical id) → adapter. */
  private adapters = new Map<string, AdapterEntry>();
  /**
   * Maps alias → canonical adapter name. Lookups via `get` / `getOrThrow`
   * fall through to this map when the requested key isn't a canonical
   * name. Kept separate from `adapters` so `listAvailable()` doesn't
   * surface the same adapter once per alias.
   */
  private aliasToName = new Map<string, string>();

  register(adapter: AgentAdapter): void {
    const entry: AdapterEntry = {
      name: adapter.name,
      aliases: adapter.aliases,
      adapter,
      proxy: adapter,
    };
    this.registerEntry(entry);
  }

  registerLazy(metadata: LazyAdapterMetadata, loader: LazyAdapterLoader): void {
    let loadActual: () => Promise<AgentAdapter>;
    const proxy = createLazyAdapterProxy(metadata, () => loadActual());
    const entry: AdapterEntry = {
      name: metadata.name,
      aliases: metadata.aliases,
      proxy,
      loader,
    };
    loadActual = () => this.loadEntry(entry);
    this.registerEntry(entry);
  }

  private registerEntry(entry: AdapterEntry): void {
    if (this.adapters.has(entry.name) || this.aliasToName.has(entry.name)) {
      throw new Error(
        `Adapter id "${entry.name}" collides with an existing registration.`,
      );
    }
    for (const alias of entry.aliases ?? []) {
      if (this.adapters.has(alias) || this.aliasToName.has(alias)) {
        throw new Error(
          `Alias "${alias}" for adapter "${entry.name}" collides with an existing registration.`,
        );
      }
    }
    this.adapters.set(entry.name, entry);
    for (const alias of entry.aliases ?? []) {
      this.aliasToName.set(alias, entry.name);
    }
  }

  get(name: string): AgentAdapter | undefined {
    const entry = this.resolveEntry(name);
    if (!entry) return undefined;
    this.startLoad(entry);
    return entry.adapter ?? entry.proxy;
  }

  async load(name: string): Promise<AgentAdapter | undefined> {
    const entry = this.resolveEntry(name);
    if (!entry) return undefined;
    return this.loadEntry(entry);
  }

  async loadAll(): Promise<AgentAdapter[]> {
    return Promise.all(
      [...this.adapters.values()].map((entry) => this.loadEntry(entry)),
    );
  }

  getOrThrow(name: string): AgentAdapter {
    const adapter = this.get(name);
    if (!adapter) {
      throw new Error(
        `Adapter "${name}" not found. Available adapters: ${this.knownNames().join(', ')}`,
      );
    }
    return adapter;
  }

  async healthCheckAll(): Promise<RegistryHealthReport> {
    const report: RegistryHealthReport = {};
    const entries = [...this.adapters.entries()];

    const results = await Promise.allSettled(
      entries.map(([, entry]) =>
        this.loadEntry(entry).then((adapter) => adapter.healthCheck()),
      ),
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
    return [...this.adapters.values()].map((entry) => entry.adapter ?? entry.proxy);
  }

  private resolveEntry(name: string): AdapterEntry | undefined {
    const direct = this.adapters.get(name);
    if (direct) return direct;
    const canonical = this.aliasToName.get(name);
    return canonical ? this.adapters.get(canonical) : undefined;
  }

  private startLoad(entry: AdapterEntry): void {
    if (!entry.loader || entry.adapter) return;
    void this.loadEntry(entry).catch(() => undefined);
  }

  private loadEntry(entry: AdapterEntry): Promise<AgentAdapter> {
    if (entry.adapter) return Promise.resolve(entry.adapter);
    if (!entry.loader) return Promise.resolve(entry.proxy);
    entry.loadPromise ??= entry.loader().then((adapter) => {
      if (adapter.name !== entry.name) {
        throw new Error(
          `Lazy adapter "${entry.name}" loaded adapter "${adapter.name}".`,
        );
      }
      entry.adapter = adapter;
      return adapter;
    });
    return entry.loadPromise;
  }

  private knownNames(): string[] {
    return [...this.adapters.keys(), ...this.aliasToName.keys()];
  }
}

function createLazyAdapterProxy(
  metadata: LazyAdapterMetadata,
  load: () => Promise<AgentAdapter>,
): AgentAdapter {
  const proxy: AgentAdapter = {
    name: metadata.name,
    aliases: metadata.aliases,
    strengths: [...metadata.strengths],
    useWhen: metadata.useWhen,
    defaultEffort: metadata.defaultEffort,
    supportsJsonSchema: metadata.supportsJsonSchema,
    enforcesReadOnly: metadata.enforcesReadOnly,
    unmetered: metadata.unmetered,
    captainCapabilities: metadata.captainCapabilities,
    execute: async (task) => (await load()).execute(task),
    healthCheck: async (options) => (await load()).healthCheck(options),
  };

  if (metadata.recognizesModel) {
    proxy.recognizesModel = metadata.recognizesModel;
  }
  if (metadata.hasExecuteWithSchema) {
    proxy.executeWithSchema = (async (prompt, schema, options) => {
      const adapter = await load();
      if (!adapter.executeWithSchema) {
        throw new Error(`Adapter "${metadata.name}" does not support schema execution.`);
      }
      return adapter.executeWithSchema(prompt, schema, options);
    }) as NonNullable<AgentAdapter['executeWithSchema']>;
  }
  if (metadata.hasExecuteWithTools) {
    proxy.executeWithTools = async (tools, messages, onToolCall, context) => {
      const adapter = await load();
      if (!adapter.executeWithTools) {
        throw new Error(`Adapter "${metadata.name}" does not support tool execution.`);
      }
      return adapter.executeWithTools(tools, messages, onToolCall, context);
    };
  }
  if (metadata.hasGetCliVersionTag) {
    proxy.getCliVersionTag = async () => {
      const adapter = await load();
      return adapter.getCliVersionTag?.();
    };
  }

  return proxy;
}

/**
 * Normalize strength strings from agent config: trim, lowercase, dedupe,
 * preserve input order. Strengths are always free-form — no enum gate.
 * Empty input → empty array (adapter ships its own defaults; users can
 * override via ~/.crew/agents.json post-install).
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

function toUseWhen(config: AgentConfig): string | undefined {
  const raw = (config as { readonly useWhen?: unknown }).useWhen;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function registerGenericAdapter(
  registry: AdapterRegistry,
  name: string,
  config: AgentConfig,
): void {
  const strengths = toStrengths(config);
  const useWhen = toUseWhen(config);

  registry.registerLazy(
    {
      name,
      strengths,
      useWhen,
      supportsJsonSchema: false,
      enforcesReadOnly: false,
      unmetered: true,
      captainCapabilities: GENERIC_CAPABILITIES,
    },
    async () => {
      const { GenericAdapter } = await import('./generic.js');
      return new GenericAdapter({
        name,
        command: config.command!,
        argsTemplate: config.args ?? ['{{prompt}}'],
        strengths,
        useWhen,
      });
    },
  );
}

function registerOpenAiCompatibleAdapter(
  registry: AdapterRegistry,
  name: string,
  config: AgentConfig,
): void {
  const strengths = toStrengths(config);
  const useWhen = toUseWhen(config);
  const resolvedApiBase = resolveOpenAiApiBase(config.apiBase);
  const unmetered = isLoopbackApiBase(resolvedApiBase);
  registry.registerLazy(
    {
      name,
      strengths,
      useWhen,
      supportsJsonSchema: false,
      enforcesReadOnly: false,
      unmetered,
      captainCapabilities: CAPTAIN_TOOL_LOOP_CAPABILITIES,
      hasExecuteWithSchema: true,
      hasExecuteWithTools: true,
    },
    async () => {
      const { OpenAiCompatibleAdapter } = await import('./openai-compatible.js');
      return new OpenAiCompatibleAdapter({
        name,
        model: config.model,
        apiBase: resolvedApiBase,
        apiKey: config.apiKey,
        strengths,
        useWhen,
      });
    },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export interface MergeCustomAgentsOptions {
  readonly reservedNames?: readonly string[];
}

export interface MergeCustomAgentsResult {
  readonly warnings: string[];
}

export function mergeCustomAgents(
  registry: AdapterRegistry,
  configMap: Record<string, unknown>,
  opts: MergeCustomAgentsOptions = {},
): MergeCustomAgentsResult {
  const warnings: string[] = [];
  const reservedNames = new Set(opts.reservedNames ?? BUILTIN_ADAPTER_NAMES);

  for (const [name, rawConfig] of Object.entries(configMap)) {
    if (!isRecord(rawConfig)) {
      warnings.push(`[agents] entry "${name}" must be an object; skipping custom adapter registration`);
      continue;
    }

    const config = rawConfig as AgentConfig;
    const adapterType = config.adapter;
    const isCustomAdapter =
      adapterType === AdapterId.OPENAI_COMPATIBLE
      || adapterType === AdapterId.GENERIC;

    if (reservedNames.has(name)) {
      if (isCustomAdapter) {
        throw new Error(
          `Custom agent "${name}" collides with built-in adapter name "${name}". Choose a different agent name.`,
        );
      }
      continue;
    }

    if (adapterType === AdapterId.OPENAI_COMPATIBLE) {
      if (typeof config.apiBase !== 'string' || config.apiBase.trim().length === 0) {
        warnings.push(
          `[agents] custom agent "${name}" uses adapter "${AdapterId.OPENAI_COMPATIBLE}" but apiBase must be a non-empty string; skipping`,
        );
        continue;
      }
      try {
        registerOpenAiCompatibleAdapter(registry, name, config);
      } catch (err) {
        warnings.push(
          `[agents] custom agent "${name}" could not be registered: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      continue;
    }

    if (adapterType === AdapterId.GENERIC) {
      if (typeof config.command !== 'string' || config.command.trim().length === 0) {
        warnings.push(
          `[agents] custom agent "${name}" uses adapter "${AdapterId.GENERIC}" but command must be a non-empty string; skipping`,
        );
        continue;
      }
      try {
        registerGenericAdapter(registry, name, config);
      } catch (err) {
        warnings.push(
          `[agents] custom agent "${name}" could not be registered: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return { warnings };
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
      registerGenericAdapter(registry, name, config);
      continue;
    }

    if (adapterType === AdapterId.OPENAI_COMPATIBLE) {
      registerOpenAiCompatibleAdapter(registry, name, config);
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
      registry.registerLazy(
        BUILTIN_ADAPTER_METADATA[adapterType],
        createBuiltinAdapterLoader(adapterType),
      );
      continue;
    }

    throw new Error(
      `Unsupported adapter "${adapterType}" for agent "${name}".`,
    );
  }

  return registry;
}

function createBuiltinAdapterLoader(adapterType: BuiltinAdapterId): LazyAdapterLoader {
  switch (adapterType) {
    case AdapterId.CLAUDE_CODE:
      return async () => {
        const { ClaudeCodeAdapter } = await import('./claude-code.js');
        return new ClaudeCodeAdapter();
      };
    case AdapterId.CODEX:
      return async () => {
        const { CodexAdapter } = await import('./codex.js');
        return new CodexAdapter();
      };
    case AdapterId.GEMINI_CLI:
      return async () => {
        const { GeminiCliAdapter } = await import('./gemini-cli.js');
        return new GeminiCliAdapter();
      };
  }
}

export function createBuiltinRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.registerLazy(
    BUILTIN_ADAPTER_METADATA[AdapterId.CLAUDE_CODE],
    createBuiltinAdapterLoader(AdapterId.CLAUDE_CODE),
  );
  registry.registerLazy(
    BUILTIN_ADAPTER_METADATA[AdapterId.CODEX],
    createBuiltinAdapterLoader(AdapterId.CODEX),
  );
  registry.registerLazy(
    BUILTIN_ADAPTER_METADATA[AdapterId.GEMINI_CLI],
    createBuiltinAdapterLoader(AdapterId.GEMINI_CLI),
  );
  return registry;
}
