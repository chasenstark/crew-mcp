export interface WorkflowStep {
  role: string;
  /**
   * Candidate agents for this step, in preference order. The captain treats
   * this as a hint, not a contract: it picks the first available candidate by
   * default but may dispatch to an alternate when there's reason (unhealthy
   * agent, strengths mismatch, user override). Must be non-empty after
   * parsing.
   */
  agents: string[];
  action: string;
  maxPasses?: number;
  condition?: string;
  criteria?: string[];
}

export interface WorkflowExecutionConfig {
  mode: 'linear' | 'judgment';
}

export interface IterateAgentDefaultsConfig {
  implementer?: string;
  reviewers?: string[];
  banList?: string[];
}

export interface PanelAgentDefaultsConfig {
  reviewers?: string[];
  banList?: string[];
}

export interface WorkflowAgentDefaultsConfig {
  iterate?: IterateAgentDefaultsConfig;
  panel?: PanelAgentDefaultsConfig;
}

export interface AgentConfig {
  adapter?: string;
  auth?: string;
  /**
   * Soft routing hints for this agent — surfaced via list_agents so the
   * captain can use them as nudges. Free-form lowercase strings (kebab-
   * case convention). Replaces the v1 `capabilities` enum.
   */
  strengths?: string[];
  model?: string;
  command?: string;
  args?: string[];
  apiBase?: string;
  apiKey?: string;
}

export interface WorkflowConfig {
  name: string;
  execution?: WorkflowExecutionConfig;
  steps: WorkflowStep[];
  roleModels?: Record<string, string>;
  agentDefaults?: WorkflowAgentDefaultsConfig;
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
 * captain-system prompt renders, plus a human-readable description. M5
 * ships three built-ins (`default` / `thorough-review` / `read-only`) and
 * the `/preset` slash command; user-defined presets live under
 * `presets:` in `workflow.yaml`.
 *
 * `hint` is intentionally a free-form soft-policy nudge, not a runtime rule —
 * it lives in the prompt, not in the tool-schema, so editing a hint between
 * turns does NOT invalidate providerSessionRef.
 */
export interface PresetConfig {
  name?: string;
  description?: string;
  hint?: string;
  /**
   * Soft-policy role suggestions, rendered as prose in the hint section of
   * the captain-system prompt. These are NOT `agent_id` values — the captain
   * still dispatches to the registered agent adapters via `list_agents`.
   * The renderer qualifies unregistered roles as "(intent — no adapter
   * registered)" to prevent the captain from hallucinating
   * `run_agent(agent_id='X')` for a role that does not exist in the
   * inventory.
   *
   * Scope note (M5 §7.5): the preset schema is intentionally tiny —
   * name, description, hint, suggestedAgentRoles. Any proposal to add
   * `steps`, `conditions`, `max_passes`, or `maxIterations` gets rejected
   * with a pointer at the "preset format balloons into a workflow DSL"
   * risk line.
   */
  suggestedAgentRoles?: string[];
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
