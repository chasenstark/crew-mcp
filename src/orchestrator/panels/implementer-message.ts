import type { RunStateV1 } from '../run-state.js';
import {
  peerMessageInputSchema,
  type PeerMessageInput,
} from '../peer-messages/schema.js';
import { logger } from '../../utils/logger.js';
import { sanitizeFromLabel } from './sanitize.js';

export function buildImplementerPeerMessage(state: RunStateV1): PeerMessageInput {
  const rawSummary = state.prompts.at(-1)?.summary?.trim();
  const body = rawSummary && rawSummary.length > 0
    ? rawSummary
    : `(no summary captured for implementer ${state.runId.slice(0, 8)}; status=${state.status})`;
  const safeFiles = safePeerMessageFiles({
    runId: state.runId,
    filesChanged: state.filesChanged,
    logMessage: 'peer-message files truncated for schema fit',
  });
  return peerMessageInputSchema.parse({
    body,
    kind: 'review',
    from_label: sanitizeFromLabel(state.agentId, `run ${state.runId.slice(0, 8)}`),
    ...(safeFiles.length > 0 ? { files: safeFiles } : {}),
  });
}

export function safePeerMessageFiles(args: {
  readonly runId: string;
  readonly filesChanged: readonly string[];
  readonly logMessage: string;
}): readonly string[] {
  const oversizeDropped = args.filesChanged.filter((f) => f.length > 4096).length;
  const safeFiles = args.filesChanged
    .filter((f) => f.length <= 4096)
    .slice(0, 1000);
  if (args.filesChanged.length > 1000 || oversizeDropped > 0) {
    logger.debug(args.logMessage, {
      runId: args.runId,
      originalCount: args.filesChanged.length,
      keptCount: safeFiles.length,
      oversizeDropped,
    });
  }
  return safeFiles;
}
