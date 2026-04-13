export interface DecomposeOutputRef {
  reasoning: string;
  tasks: {
    id: string;
    description: string;
    agent: string;
    role: 'implement' | 'review' | 'test' | 'refactor' | 'document' | 'analyze';
    dependencies: string[];
    scope: { files?: string[]; description: string };
    estimatedComplexity: 'low' | 'medium' | 'high';
  }[];
  suggestedOrder: string[];
}

export interface WorkflowState {
  status: 'running' | 'paused' | 'completed' | 'failed';
  userRequest: string;
  decomposition: DecomposeOutputRef;
  currentTaskIndex: number;
  passes: PassRecord[];
  startedAt?: string;
  completedAt?: string;
}

export interface PassRecord {
  passNumber: number;
  taskId: string;
  agentName: string;
  timestamp: string;
}

export interface PassSummary {
  passNumber: number;
  summary: string;
  unresolvedIssues: string[];
  contextForNextPass: string;
  filesInScope: string[];
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}
