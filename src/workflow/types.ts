export interface WorkflowStep {
  role: string;
  agent: string;
  action: string;
  maxPasses?: number;
  condition?: string;
  criteria?: string[];
}

export interface WorkflowExecutionConfig {
  mode: 'linear' | 'judgment';
}

export interface AgentConfig {
  adapter?: string;
  auth?: string;
  strengths?: string[];
  model?: string;
  command?: string;
  args?: string[];
  capabilities?: string[];
  apiBase?: string;
  apiKey?: string;
}

export interface WorkflowConfig {
  name: string;
  execution?: WorkflowExecutionConfig;
  steps: WorkflowStep[];
  roleModels?: Record<string, string>;
  completion: {
    strategy: string;
    fallback: string;
  };
}

/**
 * Captain-model specification. Either a single model name (applied to every
 * captain CLI) or a per-CLI map that lets the user keep models pinned across
 * `captain.cli` swaps without editing two places.
 */
export type CaptainModelMap = Partial<Record<'claude-code' | 'codex' | 'gemini-cli', string>>;

export type CaptainModelSpec = string | CaptainModelMap;

/**
 * Preset-config shape. A preset bundles a `hint` paragraph that the
 * captain-system prompt renders, plus a human-readable description. M3 ships
 * only the `default` preset; M5 adds `/preset` + user-defined presets.
 *
 * `hint` is intentionally a free-form soft-policy nudge, not a runtime rule —
 * it lives in the prompt, not in the tool-schema, so editing a hint between
 * turns does NOT invalidate providerSessionRef.
 */
export interface PresetConfig {
  name?: string;
  description?: string;
  hint?: string;
}

export interface FullConfig {
  workflow: WorkflowConfig;
  agents: Record<string, AgentConfig>;
  captain: {
    cli: string;
    model?: CaptainModelSpec;
    /** Name key into FullConfig.presets; missing → "no hint injected". */
    preset?: string;
  };
  presets?: Record<string, PresetConfig>;
  errorHandling: {
    default: {
      retry: number;
      fallback: string | null;
      onExhausted: string;
    };
  };
}
