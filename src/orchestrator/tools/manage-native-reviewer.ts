import { z } from 'zod';

import {
  getNativeReviewerWakeStatus,
  registerNativeReviewer,
  resolveNativeReviewerWake,
  type NativeReviewerWakeResult,
} from '../../codex/native-reviewer-wake.js';
import { resolveCodexThreadIdFromRequestMeta } from '../../codex/request-metadata.js';
import type { ToolCallReturn, ToolHandlerDeps, ToolRequestExtra } from './shared.js';
import { errorContent, jsonContent } from './shared.js';

export const manageNativeReviewerInputSchema = z.object({
  operation: z.enum(['register', 'status', 'resolve']),
  agent_id: z.string().uuid(),
  panel_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
}).strict();

export type ManageNativeReviewerInput = z.infer<typeof manageNativeReviewerInputSchema>;

export const MANAGE_NATIVE_REVIEWER_DESCRIPTION =
  'Codex-only lifecycle bridge for a host-native reviewer. Immediately after spawning a native reviewer, register its agent_id so a trusted SubagentStop hook may wake this exact parent thread. On a synthetic wake, read status; after collecting the result, resolve before aggregation. The hook is selective, stores no reviewer content, and never authorizes merge, discard, or other mutation.';

export interface ManageNativeReviewerDeps {
  readonly crewHome: string;
  readonly projectRoot: string;
  readonly getClientKind: Pick<ToolHandlerDeps, 'getClientKind'>['getClientKind'];
  readonly supportsNativeReviewerWake?: () => boolean;
}

export async function manageNativeReviewerToolHandler(
  args: ManageNativeReviewerInput,
  extra: ToolRequestExtra,
  deps: ManageNativeReviewerDeps,
): Promise<ToolCallReturn> {
  if (deps.getClientKind() !== 'codex') {
    return errorContent('manage_native_reviewer is available only to a supported Codex host');
  }
  if (deps.supportsNativeReviewerWake?.() === false) {
    return errorContent(
      'manage_native_reviewer wake requires Codex 0.149+ queue support; keep the turn open and join the native reviewer directly',
    );
  }
  const resolution = resolveCodexThreadIdFromRequestMeta(extra._meta);
  if (resolution.reason) return errorContent(resolution.reason);
  if (!resolution.threadId) {
    return errorContent('Codex thread id is missing from trusted MCP request metadata');
  }

  try {
    let result: NativeReviewerWakeResult;
    const target = {
      crewHome: deps.crewHome,
      repoRoot: deps.projectRoot,
      threadId: resolution.threadId,
      agentId: args.agent_id,
    };
    switch (args.operation) {
      case 'register':
        result = await registerNativeReviewer({
          ...target,
          ...(args.panel_id ? { panelId: args.panel_id } : {}),
        });
        break;
      case 'status':
        result = await getNativeReviewerWakeStatus(target);
        break;
      case 'resolve':
        result = await resolveNativeReviewerWake(target);
        break;
    }

    return jsonContent({
      operation: args.operation,
      agent_id: args.agent_id,
      ...(args.panel_id ? { panel_id: args.panel_id } : {}),
      ...result,
      mutation_authority: 'none',
    });
  } catch (error) {
    return errorContent(error instanceof Error ? error.message : String(error));
  }
}
