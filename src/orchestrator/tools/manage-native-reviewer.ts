import { z } from 'zod';

import {
  nativeReviewerTaskNameSchema,
  resolveNativeReviewerTaskIdentity,
} from '../../codex/native-reviewer-identity.js';
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
  agent_id: z.string().uuid().optional(),
  task_name: nativeReviewerTaskNameSchema.optional(),
  panel_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/).optional(),
}).strict().superRefine((args, context) => {
  if ((args.agent_id === undefined) === (args.task_name === undefined)) {
    context.addIssue({ code: 'custom', message: 'Provide exactly one of agent_id or task_name' });
  }
  if (args.task_name !== undefined && args.operation !== 'register') {
    context.addIssue({ code: 'custom', message: 'task_name is supported only for register' });
  }
});

export type ManageNativeReviewerInput = z.infer<typeof manageNativeReviewerInputSchema>;

export const MANAGE_NATIVE_REVIEWER_DESCRIPTION =
  'Codex-only lifecycle bridge for a host-native reviewer. Register exactly one host-returned agent_id UUID or canonical task_name (/root/path). Task names are resolved through bounded public metadata for this exact parent and repository; save the returned agent_id for status and resolve. If registration fails, join the reviewer through native tools. After collecting a successfully registered reviewer, resolve before aggregation. A trusted SubagentStop hook may wake this parent; it stores no reviewer content and grants no mutation authority.';

export interface ManageNativeReviewerDeps {
  readonly crewHome: string;
  readonly projectRoot: string;
  readonly getClientKind: Pick<ToolHandlerDeps, 'getClientKind'>['getClientKind'];
  readonly supportsNativeReviewerWake?: () => boolean;
  readonly resolveTaskIdentity?: typeof resolveNativeReviewerTaskIdentity;
}

export async function manageNativeReviewerToolHandler(
  args: ManageNativeReviewerInput,
  extra: ToolRequestExtra,
  deps: ManageNativeReviewerDeps,
): Promise<ToolCallReturn> {
  // The live MCP registration uses schema.shape, which omits object-level
  // refinements. Enforce the complete contract before lookup or state writes.
  const parsed = manageNativeReviewerInputSchema.safeParse(args);
  if (!parsed.success) {
    return errorContent('Invalid native reviewer identity: register requires exactly one agent_id UUID or canonical task_name; status and resolve require agent_id only');
  }
  args = parsed.data;
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
    let agentId = args.agent_id;
    if (args.task_name !== undefined) {
      try {
        agentId = await (deps.resolveTaskIdentity ?? resolveNativeReviewerTaskIdentity)({
          repoRoot: deps.projectRoot,
          threadId: resolution.threadId,
          taskName: args.task_name,
        });
      } catch {
        return errorContent('Native reviewer task identity could not be verified uniquely; keep the turn open and join this reviewer through native tools. No wake registration was created');
      }
    }
    if (!agentId || !z.string().uuid().safeParse(agentId).success
      || agentId.toLowerCase() === resolution.threadId.toLowerCase()) {
      return errorContent('Native reviewer identity must be a child UUID distinct from the parent; join the reviewer through native tools');
    }
    let result: NativeReviewerWakeResult;
    const target = {
      crewHome: deps.crewHome,
      repoRoot: deps.projectRoot,
      threadId: resolution.threadId,
      agentId,
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
      agent_id: agentId,
      ...(args.panel_id ? { panel_id: args.panel_id } : {}),
      ...result,
      mutation_authority: 'none',
    });
  } catch (error) {
    return errorContent(error instanceof Error ? error.message : String(error));
  }
}
