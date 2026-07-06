import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  RUN_AUTH_SIDECAR_FILENAME,
  runAuthSidecarSchema,
  type DispatchMcpEnv,
  type RunAuthSidecar,
} from './sidecar-schema.js';
import { isValidRunId } from '../run-id.js';

export type SidecarWriteMode = 'must-not-exist' | 'replace-existing';

export class RunAuthError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'RunAuthError';
    this.code = code;
  }
}

export interface IssueRunAuthSidecarArgs {
  readonly crewHome: string;
  readonly runId: string;
  readonly agentId: string;
  readonly repoRoot: string;
  readonly captainServeInstance: string;
  readonly writeMode: SidecarWriteMode;
  readonly now?: Date;
}

export interface IssuedRunAuth {
  readonly sidecar: RunAuthSidecar;
  readonly dispatchMcpEnv: DispatchMcpEnv;
}

const DEFAULT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function runAuthSidecarPath(crewHome: string, runId: string): string {
  assertValidRunId(runId);
  return join(crewHome, 'runs', runId, RUN_AUTH_SIDECAR_FILENAME);
}

export function assertValidRunId(runId: string): void {
  if (isValidRunId(runId)) return;
  throw new RunAuthError('run_id_invalid', `run_id_invalid: ${runId}`);
}

export function repoHash(repoRoot: string): string {
  return createHash('sha256').update(repoRoot).digest('hex').slice(0, 12);
}

export function generateRunToken(): string {
  return randomBytes(32).toString('hex');
}

export function issueRunAuthSidecar(args: IssueRunAuthSidecarArgs): IssuedRunAuth {
  const issuedAt = (args.now ?? new Date()).toISOString();
  const sidecar: RunAuthSidecar = {
    schema_version: 1,
    run_id: args.runId,
    agent_id: args.agentId,
    token: generateRunToken(),
    repo_root: args.repoRoot,
    repo_hash: repoHash(args.repoRoot),
    captain_pid: process.pid,
    captain_serve_instance: args.captainServeInstance,
    issued_at: issuedAt,
    revoked: false,
  };
  writeSidecar(runAuthSidecarPath(args.crewHome, args.runId), sidecar, args.writeMode);
  return {
    sidecar,
    dispatchMcpEnv: {
      CREW_RUN_ID: args.runId,
      CREW_RUN_TOKEN: sidecar.token,
    },
  };
}

export function readRunAuthSidecar(crewHome: string, runId: string): RunAuthSidecar {
  const path = runAuthSidecarPath(crewHome, runId);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new RunAuthError('sidecar_missing', `sidecar_missing: ${runId}`);
  }
  if ((stat.mode & 0o777) !== 0o600) {
    throw new RunAuthError('sidecar_permission_invalid', `sidecar_permission_invalid: ${runId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    throw new RunAuthError(
      'sidecar_invalid',
      `sidecar_invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const result = runAuthSidecarSchema.safeParse(parsed);
  if (!result.success) {
    throw new RunAuthError('sidecar_invalid', `sidecar_invalid: ${result.error.message}`);
  }
  return result.data;
}

export function validateRunAuthSidecar(args: {
  readonly crewHome: string;
  readonly runId: string;
  readonly token: string;
  readonly now?: Date;
  readonly tokenTtlMs?: number;
}): RunAuthSidecar {
  const sidecar = readRunAuthSidecar(args.crewHome, args.runId);
  if (sidecar.run_id !== args.runId) {
    throw new RunAuthError('sidecar_run_mismatch', `sidecar_run_mismatch: ${args.runId}`);
  }
  if (sidecar.repo_hash !== repoHash(sidecar.repo_root)) {
    throw new RunAuthError('sidecar_repo_hash_invalid', `sidecar_repo_hash_invalid: ${args.runId}`);
  }
  if (!existsSync(sidecar.repo_root)) {
    throw new RunAuthError('repo_root_missing', `repo_root_missing: ${sidecar.repo_root}`);
  }
  if (!constantTimeTokenEqual(sidecar.token, args.token)) {
    throw new RunAuthError('token_invalid', `token_invalid: ${args.runId}`);
  }
  if (sidecar.revoked) {
    throw new RunAuthError('token_revoked', `token_revoked: ${args.runId}`);
  }
  if (isTokenExpired(sidecar, args.now ?? new Date(), args.tokenTtlMs ?? resolveTokenTtlMs())) {
    throw new RunAuthError('token_expired', `token_expired: ${args.runId}`);
  }
  return sidecar;
}

export function revokeRunAuthSidecar(
  crewHome: string,
  runId: string,
  now = new Date(),
): RunAuthSidecar | undefined {
  let sidecar: RunAuthSidecar;
  try {
    sidecar = readRunAuthSidecar(crewHome, runId);
  } catch (err) {
    if (err instanceof RunAuthError && err.code === 'sidecar_missing') return undefined;
    throw err;
  }
  if (sidecar.revoked) return sidecar;
  const next: RunAuthSidecar = {
    ...sidecar,
    revoked: true,
    revoked_at: now.toISOString(),
  };
  writeSidecar(runAuthSidecarPath(crewHome, runId), next, 'replace-existing');
  return next;
}

export function deleteRunAuthSidecar(crewHome: string, runId: string): void {
  rmSync(runAuthSidecarPath(crewHome, runId), { force: true });
}

export function resolveTokenTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CREW_RUN_AUTH_TOKEN_TTL_MS;
  if (raw === undefined) return DEFAULT_TOKEN_TTL_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOKEN_TTL_MS;
  return Math.floor(parsed);
}

function isTokenExpired(sidecar: RunAuthSidecar, now: Date, ttlMs: number): boolean {
  const issuedMs = Date.parse(sidecar.issued_at);
  if (!Number.isFinite(issuedMs)) return true;
  return now.getTime() - issuedMs > ttlMs;
}

function constantTimeTokenEqual(expected: string, actual: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(expected) || !/^[0-9a-f]{64}$/.test(actual)) return false;
  const expectedBuffer = Buffer.from(expected, 'hex');
  const actualBuffer = Buffer.from(actual, 'hex');
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function writeSidecar(path: string, sidecar: RunAuthSidecar, mode: SidecarWriteMode): void {
  mkdirSync(join(path, '..'), { recursive: true });
  if (mode === 'must-not-exist' && existsSync(path)) {
    throw new RunAuthError('unexpected_sidecar_collision', `unexpected_sidecar_collision: ${path}`);
  }
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeSync(fd, JSON.stringify(sidecar, null, 2) + '\n', undefined, 'utf-8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    chmodSync(path, 0o600);
    const stat = statSync(path);
    if ((stat.mode & 0o777) !== 0o600) {
      throw new RunAuthError('sidecar_permission_unfixable', `sidecar_permission_unfixable: ${path}`);
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Surface the original error.
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // Surface the original error.
    }
    throw err;
  }
}
