import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ToolCall, ToolResult } from '../adapters/types.js';
import type { OrchestratorActionServer } from './action-server.js';

export interface OrchestratorMcpServer {
  close: () => Promise<void>;
}

export async function startOrchestratorMcpStdioServer(
  actionServer: OrchestratorActionServer,
  onToolCall: (call: ToolCall) => Promise<ToolResult>,
): Promise<OrchestratorMcpServer> {
  const server = new McpServer({
    name: 'orchestrator-action-server',
    version: '0.1.0',
  });

  for (const tool of actionServer.listTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // MCP input validation is intentionally permissive here because
        // the orchestrator action handlers already validate with Zod.
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        const result = await onToolCall({
          name: tool.name,
          input: args as Record<string, unknown>,
        });
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result.output),
            },
          ],
        };
      },
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    close: () => server.close(),
  };
}
