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

export interface FullConfig {
  workflow: WorkflowConfig;
  agents: Record<string, AgentConfig>;
  orchestrator: {
    cli: string;
    model?: string;
  };
  errorHandling: {
    default: {
      retry: number;
      fallback: string | null;
      onExhausted: string;
    };
  };
}
