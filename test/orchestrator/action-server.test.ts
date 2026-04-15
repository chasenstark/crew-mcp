import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OrchestratorActionServer } from '../../src/orchestrator/action-server.js';

describe('OrchestratorActionServer', () => {
  it('namespaces tools and resolves namespaced calls', () => {
    const server = new OrchestratorActionServer([
      {
        name: 'run_decompose',
        description: 'Decompose request',
        inputSchema: z.object({}).passthrough(),
      },
    ]);

    const tools = server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__orchestrator__run_decompose');

    const resolved = server.resolveToolCall({
      name: tools[0].name,
      input: {},
    });
    expect(resolved.name).toBe('run_decompose');
  });

  it('produces stable schema hashes for equivalent tool catalogs', () => {
    const first = new OrchestratorActionServer([
      {
        name: 'run_dispatch',
        description: 'Dispatch task',
        inputSchema: z.object({
          taskId: z.string().optional(),
        }).passthrough(),
      },
    ]);

    const second = new OrchestratorActionServer([
      {
        name: 'run_dispatch',
        description: 'Dispatch task',
        inputSchema: z.object({
          taskId: z.string().optional(),
        }).passthrough(),
      },
    ]);

    expect(first.getToolSchemaHash()).toBe(second.getToolSchemaHash());
  });
});
