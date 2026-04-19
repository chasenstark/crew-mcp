import type { PipelineEvents } from './pipeline.js';
import type { PassSummary, WorkflowState } from '../state/types.js';

export interface ResumeParams {
  workflowState: WorkflowState;
  previousSummaries: PassSummary[];
}

/**
 * CrewRunner — the lifecycle contract shared by Pipeline (linear, deprecated)
 * and JudgmentRunner (M1.5+).
 *
 * Post-M1.5-11: the slot-based ask_user pair (requestUserInput /
 * provideUserInput) is gone. ask_user is a dispatcher-backed tool owned by
 * the session loop; attach via src/cli/runtime/ask-user.ts, which hooks
 * CaptainSession + ToolDispatcher directly.
 */
export interface CrewRunner {
  run(userRequest: string): Promise<string>;
  resume(params: ResumeParams): Promise<string>;
  cancel(reason?: string): void;
  markInterrupted(reason?: string): void;
  on(event: keyof PipelineEvents, fn: (...args: any[]) => void): this;
  removeAllListeners(): this;
}
