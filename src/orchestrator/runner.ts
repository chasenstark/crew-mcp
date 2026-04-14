import type { PipelineEvents } from './pipeline.js';
import type { PassSummary, WorkflowState } from '../state/types.js';

export interface ResumeParams {
  workflowState: WorkflowState;
  previousSummaries: PassSummary[];
}

export interface OrchestrationRunner {
  run(userRequest: string): Promise<string>;
  resume(params: ResumeParams): Promise<string>;
  requestUserInput(question: string): Promise<string>;
  provideUserInput(input: string): void;
  cancel(reason?: string): void;
  markInterrupted(reason?: string): void;
  on(event: keyof PipelineEvents, fn: (...args: any[]) => void): this;
  removeAllListeners(): this;
}
