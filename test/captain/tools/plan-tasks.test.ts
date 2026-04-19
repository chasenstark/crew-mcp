import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { dispatchPlanTasks } from '../../../src/captain/tools/plan-tasks.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';
import type { WorkflowConfig } from '../../../src/workflow/types.js';

function makeAdapter(overrides: Partial<AgentAdapter> = {}): AgentAdapter {
  return {
    name: 'fake-captain',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    executeWithSchema: async <T extends z.ZodType>(_prompt: string, _schema: T) => {
      const value = {
        reasoning: 'decomposed',
        tasks: [
          {
            id: 'task-1',
            description: 'do the devops thing',
            agent: 'codex',
            role: 'devops', // free-form role allowed post-M3-6
            dependencies: [],
            scope: { description: 'infra' },
            estimatedComplexity: 'low' as const,
          },
        ],
        suggestedOrder: ['task-1'],
      };
      return value as z.infer<T>;
    },
    healthCheck: async () => ({ available: true, authenticated: true }),
    ...overrides,
  };
}

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

describe('dispatchPlanTasks', () => {
  it('accepts a free-form role string (e.g., devops)', async () => {
    const out = await dispatchPlanTasks(
      { user_request: 'stand up monitoring' },
      { captain: makeAdapter(), workflow, agents: [{ name: 'codex', capabilities: ['implement'] }] },
    );
    expect(out.tasks[0].role).toBe('devops');
  });

  it('rejects an empty user_request at the schema level', () => {
    const schema = z.object({ user_request: z.string().min(1) });
    expect(() => schema.parse({ user_request: '' })).toThrow();
  });

  it('threads hints into the request (prefix)', async () => {
    const captured: { prompt?: string } = {};
    const captain = makeAdapter({
      executeWithSchema: async <T extends z.ZodType>(prompt: string, _schema: T) => {
        captured.prompt = prompt;
        return {
          reasoning: '',
          tasks: [
            {
              id: 'a',
              description: 'x',
              agent: 'codex',
              role: 'implement',
              dependencies: [],
              scope: { description: 'x' },
              estimatedComplexity: 'low' as const,
            },
          ],
          suggestedOrder: ['a'],
        } as z.infer<T>;
      },
    });
    await dispatchPlanTasks(
      { user_request: 'fix login', hints: ['ignore old auth module', 'keep UX identical'] },
      { captain, workflow, agents: [{ name: 'codex', capabilities: ['implement'] }] },
    );
    expect(captured.prompt).toMatch(/Planner hints:/);
    expect(captured.prompt).toMatch(/- ignore old auth module/);
    expect(captured.prompt).toMatch(/- keep UX identical/);
  });
});
