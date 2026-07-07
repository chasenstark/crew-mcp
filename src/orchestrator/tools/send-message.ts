import { z } from 'zod';

import {
  RunAuthError,
  validateRunAuthSidecar,
  type RunAuthSidecar,
} from '../auth/index.js';
import { appendMessage, CaptainInboxError } from '../captain-inbox/store.js';
import { captainInboxKindSchema } from '../captain-inbox/schema.js';
import type { ToolCallReturn } from './shared.js';

const BODY_CAP_CHARS = 16 * 1024;
const EXCERPT_TEXT_CAP_CHARS = 4 * 1024;

export const sendMessageInputSchema = z.object({
  body: z.string().min(1),
  kind: captainInboxKindSchema.default('note'),
  files: z.array(z.string()).max(20).optional(),
  excerpts: z.array(z.object({
    file: z.string(),
    range: z.array(z.number().int().min(1)).length(2)
      .refine((range) => range[0] <= range[1], 'range start must be <= end'),
    text: z.string(),
  })).max(8).optional(),
  to: z.object({ kind: z.literal('captain') }).default({ kind: 'captain' }),
});

export type SendMessageInput = z.infer<typeof sendMessageInputSchema>;

export const SEND_MESSAGE_DESCRIPTION =
  'Worker-only tool for sending a finalized structured message back to the captain inbox. Required: body. Optional: kind, files, excerpts. Identity is server-stamped from the current run.';

export interface SendMessageToolDeps {
  readonly crewHome: string;
  readonly workerAuth?: RunAuthSidecar;
  readonly env?: NodeJS.ProcessEnv;
}

export async function sendMessageToolHandler(
  args: SendMessageInput,
  deps: SendMessageToolDeps,
): Promise<ToolCallReturn> {
  if (deps.workerAuth === undefined) {
    return sendMessageError('worker_mode_required');
  }

  let sidecar: RunAuthSidecar;
  try {
    sidecar = revalidateWorkerAuth(deps.crewHome, deps.workerAuth, deps.env ?? process.env);
  } catch (err) {
    return sendMessageError(errorCodeForAuthError(err));
  }

  const warnings: string[] = [];
  const body = truncateWithWarning(args.body, resolveBodyCap(deps.env), 'body', warnings);
  const excerpts = args.excerpts?.map((excerpt, index) => ({
    file: excerpt.file,
    range: [excerpt.range[0], excerpt.range[1]] as [number, number],
    text: truncateWithWarning(
      excerpt.text,
      EXCERPT_TEXT_CAP_CHARS,
      `excerpts[${index}].text`,
      warnings,
    ).value,
  }));

  try {
    // The sidecar can still be revoked between this validation and the inbox
    // write. That TOCTOU is accepted for v1: the write is append-only,
    // captain-scoped, and later sends will fail once revocation is observed.
    const message = await appendMessage({
      crewHome: deps.crewHome,
      message: {
        to: { kind: 'captain' },
        from: {
          kind: 'run',
          run_id: sidecar.run_id,
          agent_id: sidecar.agent_id,
        },
        kind: args.kind,
        body: body.value,
        ...(body.truncated ? { body_truncated: { original_length: body.originalLength } } : {}),
        ...(args.files !== undefined ? { files: [...args.files] } : {}),
        ...(excerpts !== undefined ? { excerpts } : {}),
        worker_run_id_at_send: sidecar.run_id,
        worker_agent_id_at_send: sidecar.agent_id,
        repo_root_at_send: sidecar.repo_root,
      },
      env: deps.env,
    });
    const result = {
      msg_id: message.msg_id,
      created_at: message.created_at,
      warnings,
    };
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      structuredContent: result,
    };
  } catch (err) {
    if (err instanceof CaptainInboxError) return sendMessageError(err.code);
    return sendMessageError(err instanceof Error ? err.message : String(err));
  }
}

function revalidateWorkerAuth(
  crewHome: string,
  initial: RunAuthSidecar,
  env: NodeJS.ProcessEnv,
): RunAuthSidecar {
  const token = env.CREW_RUN_TOKEN;
  if (!token) throw new RunAuthError('token_invalid');
  try {
    return validateRunAuthSidecar({ crewHome, runId: initial.run_id, token });
  } catch (err) {
    if (err instanceof RunAuthError && err.code === 'repo_root_missing') {
      throw new RunAuthError('repo_root_mismatch');
    }
    throw err;
  }
}

function errorCodeForAuthError(err: unknown): string {
  if (!(err instanceof RunAuthError)) return err instanceof Error ? err.message : String(err);
  switch (err.code) {
    case 'sidecar_missing':
      return 'run_not_active';
    case 'token_invalid':
      return 'token_invalid';
    case 'token_revoked':
      return 'token_revoked';
    case 'repo_root_mismatch':
    case 'repo_root_missing':
      return 'repo_root_mismatch';
    default:
      return err.code;
  }
}

function sendMessageError(code: string): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text: code }],
    structuredContent: { error: code },
    isError: true,
  };
}

function resolveBodyCap(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREW_CAPTAIN_INBOX_BODY_CAP_CHARS;
  if (raw === undefined || raw.trim() === '') return BODY_CAP_CHARS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return BODY_CAP_CHARS;
  return Math.floor(parsed);
}

function truncateWithWarning(
  text: string,
  cap: number,
  label: string,
  warnings: string[],
): { readonly value: string; readonly truncated: false }
  | { readonly value: string; readonly truncated: true; readonly originalLength: number } {
  if (text.length <= cap) return { value: text, truncated: false };
  const marker = `[... truncated; original was ${text.length} chars]`;
  const prefixLength = Math.max(0, cap - marker.length);
  const value = marker.length >= cap ? marker.slice(0, cap) : `${text.slice(0, prefixLength)}${marker}`;
  warnings.push(`captain_inbox.${label}_truncated: original was ${text.length} chars, capped at ${cap}`);
  return { value, truncated: true, originalLength: text.length };
}
