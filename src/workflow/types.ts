export interface WorkflowStep {
  role: string;
  agent: string;
  action: string;
  maxPasses?: number;
  condition?: string;
  criteria?: string[];
}

export interface AgentConfig {
  adapter: string;
  auth: string;
  strengths: string[];
}

export interface WorkflowConfig {
  name: string;
  steps: WorkflowStep[];
  completion: {
    strategy: string;
    fallback: string;
  };
}

export interface FullConfig {
  workflow: WorkflowConfig;
  agents: Record<string, AgentConfig>;
  orchestrator: { cli: string };
  errorHandling: {
    default: {
      retry: number;
      fallback: string | null;
      onExhausted: string;
    };
  };
}
