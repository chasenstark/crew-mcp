/**
 * Captain-runner event + registry types.
 *
 * Post-M4-4 home for the two types that previously lived in `pipeline.ts`
 * (deleted in M4): the EventEmitter signature for a runner's lifecycle
 * callbacks, and the minimal `AgentRegistry` shape that a runner needs to
 * look up and list adapters. Keeping them together here captures the
 * semantic coupling ("how an in-process runner talks to its registry and
 * emits events") without reviving any of the pipeline scheduler surface.
 *
 * The `PipelineEvents` name is retained only because `JudgmentRunner`
 * extends `EventEmitter<PipelineEvents>` — renaming would churn every
 * `.on('step:start', ...)` call site without meaningful benefit. Think of
 * it as "runner events"; the `Pipeline` prefix is historical.
 */

import type { AgentAdapter, TaskResult } from '../adapters/types.js';

export interface PipelineEvents {
  'step:start': (step: string, data?: Record<string, unknown>) => void;
  'step:complete': (step: string, data?: Record<string, unknown>) => void;
  'agent:start': (agentName: string, taskId: string, description: string) => void;
  'agent:output': (agentName: string, taskId: string, chunk: string) => void;
  'agent:complete': (agentName: string, taskId: string, result: TaskResult) => void;
  'report': (text: string) => void;
  'ask_user': (question: string) => void;
  'error': (error: Error, context?: Record<string, unknown>) => void;
}

export interface AgentRegistry {
  get(name: string): AgentAdapter | undefined;
  list(): { name: string; strengths: string[] }[];
}
