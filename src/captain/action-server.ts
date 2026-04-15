import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ToolCall, ToolDefinition } from '../adapters/types.js';

export const DEFAULT_TOOL_NAMESPACE = 'mcp__crew__';

export interface ActionCatalogEntry {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export class CaptainActionServer {
  readonly toolNamespace: string;

  constructor(
    private readonly actions: ActionCatalogEntry[],
    namespace = DEFAULT_TOOL_NAMESPACE,
  ) {
    this.toolNamespace = namespace;
  }

  listTools(): ToolDefinition[] {
    return this.actions.map((action) => ({
      name: `${this.toolNamespace}${action.name}`,
      description: action.description,
      inputSchema: z.toJSONSchema(action.inputSchema) as Record<string, unknown>,
    }));
  }

  getToolSchemaHash(): string {
    const serialized = stableStringify(this.listTools());
    return createHash('sha256').update(serialized).digest('hex');
  }

  resolveToolCall(call: ToolCall): ToolCall {
    if (call.name.startsWith(this.toolNamespace)) {
      return {
        ...call,
        name: call.name.slice(this.toolNamespace.length),
      };
    }
    return call;
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortRecursively(value));
}

function sortRecursively(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecursively);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }

  return Object.keys(value as Record<string, unknown>)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortRecursively((value as Record<string, unknown>)[key]);
      return acc;
    }, {});
}
