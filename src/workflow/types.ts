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

/**
 * Custom-agent entry shape. Not part of `workflow.yaml` anymore — this is
 * the shape `mergeCustomAgents` consumes from per-machine agent prefs
 * (`~/.crew/agents.json`) when registering `generic` / `openai-compatible`
 * custom agents.
 */
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

/**
 * The surviving `.crew/workflow.yaml` surface. Everything else the v0.1
 * config carried (steps, roleModels, captain.*, presets, errorHandling,
 * an `agents:` block) had no runtime readers and was pruned 2026-07-07 —
 * `workflow.agentDefaults` is the only block the runtime consumes
 * (get_crew_preferences, run_panel).
 */
export interface FullConfig {
  workflow: {
    agentDefaults?: WorkflowAgentDefaultsConfig;
  };
}
