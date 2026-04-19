import type { TaskResult } from '../adapters/types.js';
import type { PathTaken, ProviderSession } from '../provider-session.js';

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
  pathTaken: PathTaken;
}

export interface ToolTranscriptMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  name?: string;
}

// SessionMessage is the captain's durable conversation-history record. The
// CaptainSession keeps a log of these across turns; the session loop feeds the
// list into each adapter turn (either as the resume seed, or as the full-replay
// seed after a providerSessionRef invalidation).
//
// Relationship to ToolTranscriptMessage: that type is the shape the adapter
// tool-loop expects on the wire; SessionMessage is the shape the session
// persists. `tool_call` and `tool_result` roles are distinct here so replay can
// preserve the call/result pairing; the adapter conversion happens in
// CaptainSession.toToolLoopMessages().
export interface SessionUserMessage {
  role: 'user';
  text: string;
  timestamp: string;
}

export interface SessionAssistantMessage {
  role: 'assistant';
  text: string;
  timestamp: string;
}

export interface SessionToolCallMessage {
  role: 'tool_call';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export interface SessionToolResultMessage {
  role: 'tool_result';
  toolCallId: string;
  output: unknown;
  status: 'success' | 'error' | 'cancelled';
  timestamp: string;
}

export type SessionMessage =
  | SessionUserMessage
  | SessionAssistantMessage
  | SessionToolCallMessage
  | SessionToolResultMessage;

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
  providerSession?: ProviderSession;
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

