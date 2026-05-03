import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CaptainActionServer } from '../../src/orchestrator/action-server.js';

describe('CaptainActionServer', () => {
  it('namespaces tools and resolves namespaced calls', () => {
    const server = new CaptainActionServer([
      {
        name: 'run_decompose',
        description: 'Decompose request',
        inputSchema: z.object({}).passthrough(),
      },
    ]);

    const tools = server.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('mcp__crew__run_decompose');

    const resolved = server.resolveToolCall({
      name: tools[0].name,
      input: {},
    });
    expect(resolved.name).toBe('run_decompose');
  });

  it('produces stable schema hashes for equivalent tool catalogs', () => {
    const first = new CaptainActionServer([
      {
        name: 'run_dispatch',
        description: 'Dispatch task',
        inputSchema: z.object({
          taskId: z.string().optional(),
        }).passthrough(),
      },
    ]);

    const second = new CaptainActionServer([
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
