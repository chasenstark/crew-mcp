import type { ToolResult } from '../types.js';

export function resolveTerminalOutput(result: ToolResult): string {
  if (result.terminalOutput !== undefined) return result.terminalOutput;
  if (typeof result.output === 'string') return result.output;
  const serialized = JSON.stringify(result.output);
  return serialized === undefined ? '' : serialized;
}
