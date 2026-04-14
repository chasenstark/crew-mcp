import type { TaskResult } from '../adapters/types.js';

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

export type TaskLifecycleState = 'pending' | 'running' | 'done' | 'failed' | 'blocked';

export interface TaskArtifacts {
  dispatch?: {
    agentPrompt: string;
    workingDirectory?: string;
    expectedOutputs: string[];
    successCriteria: string;
  };
  agentResult?: TaskResult;
  ingest?: unknown;
  summary?: PassSummary;
  judge?: unknown;
}

export interface ActionRecord {
  sequence: number;
  action: string;
  target?: { taskId?: string };
  payload: unknown;
  reasoning?: string;
  result: {
    status: 'success' | 'error' | 'skipped';
    data?: unknown;
    error?: string;
  };
  startedAt: string;
  completedAt: string;
  pathTaken: 'native' | 'adapter' | 'fallback';
}

export interface ToolTranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

export interface WorkflowState {
  schemaVersion?: number;
  executionMode?: 'linear' | 'judgment';
  runId?: string;
  status: 'running' | 'interrupted' | 'completed' | 'failed';
  userRequest: string;
  decomposition: DecomposeOutputRef;
  currentTaskIndex: number;
  passes: PassRecord[];
  taskStates?: Record<string, TaskLifecycleState>;
  pendingQueue?: string[];
  artifactsByTask?: Record<string, TaskArtifacts>;
  actionHistory?: ActionRecord[];
  controllerCursor?: number;
  toolCallTranscript?: ToolTranscriptMessage[];
  nativeToolCalls?: number;
  startedAt?: string;
  completedAt?: string;
  interruptedAt?: string;
  lastError?: string;
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
