import { execa } from 'execa';
import { z } from 'zod';
import { extractJson } from '../utils/json-parse.js';
import { HealthCheckCache } from '../utils/health-check-cache.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import { classifyTextFailure } from './failure-classifier.js';
import { AGY_MODEL_LABELS, AGY_MODEL_LABEL_SET } from './agy-models.js';
import type {
  AgentAdapter,
  AgentStrength,
  ExecuteOptions,
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';

/**
 * `agy` = the Antigravity CLI, Google's replacement for the now-dead
 * gemini-cli individual-auth path. This adapter is intentionally NOT a
 * drop-in for gemini-cli.ts: different binary, flags, model labels, resume
 * mechanism, and write-sandbox behavior. It is **write-mode only** — see the
 * read-only hard-reject below and docs/plans/active/agy-adapter.md for why
 * agy read-only cannot be enforced.
 */

/**
 * Minimum `agy` version. 1.0.12 dropped JSON envelopes on stdout (upstream
 * bug #76) and had no usable headless contract; 1.0.14 fixes it and ships the
 * `--output-format json` envelope this adapter parses. healthCheck rejects
 * older releases so users get a clear error instead of a mystery empty result.
 */
export const AGY_MIN_VERSION = { major: 1, minor: 0, patch: 14 } as const;

/**
 * agy keys models by exact human LABEL (not id) and SILENTLY falls back to its
 * default model on an unknown label (verified: a bogus `--model` returns
 * status:SUCCESS answered by the default). So the adapter validates the label
 * at dispatch and `recognizesModel` matches the pinned set EXACTLY — never a
 * substring, because the labels contain "Claude…"/"GPT-OSS…" which a loose
 * test would mis-claim. The list lives in ./agy-models.js so the lazy registry
 * can share it without importing this adapter's heavy deps.
 */

/**
 * When the caller supplies a wall-clock budget we pass it to agy as
 * `--print-timeout <budget>` so agy self-limits with a clean ERROR envelope
 * rather than getting SIGKILLed mid-generation. execa's hard timeout is set a
 * little ABOVE the agy budget so agy's own clean timeout fires first; execa is
 * only the backstop if agy ignores its own limit.
 */
const PRINT_TIMEOUT_EXECA_BUFFER_MS = 15_000;

/**
 * The JSON object `agy --output-format json` prints (undocumented in --help
 * but stable on 1.0.14). Success carries `status:"SUCCESS"` + a non-empty
 * `response`; failure carries `status:"ERROR"`, an empty `response`, an
 * `error` message, and zeroed usage + exit 1.
 */
export interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    total_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * Parse the single-object `--output-format json` envelope. Returns null when
 * stdout is empty or not a JSON object — callers MUST treat null as a failure,
 * never as an empty-but-successful response (the gemini-cli silent
 * empty-string parser is deliberately NOT reused here).
 */
export function parseAgyEnvelope(stdout: string): AgyEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as AgyEnvelope;
    }
  } catch {
    // Fall through to the lenient extractor: agy may prefix the envelope with
    // a stray log line. extractJson finds the embedded object; still subject
    // to the status gate below.
    try {
      const extracted = extractJson(trimmed) as unknown;
      if (extracted && typeof extracted === 'object' && !Array.isArray(extracted)) {
        return extracted as AgyEnvelope;
      }
    } catch {
      logger.warn('[adapter:agy] --output-format json output was not valid JSON');
    }
  }
  return null;
}

export function isAgyVersionBelowFloor(
  parsed: { major: number; minor: number; patch: number } | null,
): boolean {
  if (!parsed) return true;
  if (parsed.major < AGY_MIN_VERSION.major) return true;
  if (parsed.major > AGY_MIN_VERSION.major) return false;
  if (parsed.minor < AGY_MIN_VERSION.minor) return true;
  if (parsed.minor > AGY_MIN_VERSION.minor) return false;
  return parsed.patch < AGY_MIN_VERSION.patch;
}

function renderProcessFailureOutput(stdout: string, stderr: string, message: string): string {
  const envelope = parseAgyEnvelope(stdout);
  if (envelope?.error) return envelope.error;
  if (stderr) return stderr;
  if (stdout) return stdout;
  return message;
}

export class AgyAdapter implements AgentAdapter {
  readonly name = AgentId.AGY;
  // Soft routing hints; users override via ~/.crew/agents.json. These MUST NOT
  // advertise agy as a reviewer or read-only agent — agy is write-mode only.
  readonly strengths: AgentStrength[] = [...BUILTIN_AGENT_ROUTING[AgentId.AGY].strengths];
  readonly useWhen = BUILTIN_AGENT_ROUTING[AgentId.AGY].useWhen;
  // No native JSON-schema flag; executeWithSchema post-validates with Zod.
  readonly supportsJsonSchema = false;
  // agy CANNOT enforce a read-only filesystem sandbox: absolute paths in a
  // prompt escape any --add-dir/--sandbox, and there is no --policy/tool-deny
  // equivalent to gemini's. So read-only is not "weakly enforced" — it is
  // refused outright (rejectsReadOnly). enforcesReadOnly stays false.
  readonly enforcesReadOnly = false;
  // agy v1 is dispatched WRITE-MODE ONLY. A read-only dispatch is hard-rejected
  // fail-closed at the plan layer (planRunAgent) so the run never starts; this
  // flag is what that layer keys on. Review/triage routes to codex/claude.
  readonly rejectsReadOnly = true;
  // A write dispatch must run inside its own crew-allocated worktree. The
  // planner refuses a working_directory override for agy so an untrusted prompt
  // can't redirect writes outside the isolated worktree.
  readonly requiresCrewWorktree = true;
  // agy terminal execution has no file-change stream → run-agent's worktree
  // git-status fallback is the source of truth for filesModified.
  readonly filesModifiedReliable = false;
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && AGY_MODEL_LABEL_SET.has(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('agy', ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0) return undefined;
    const match = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.AGY, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    // Defense in depth: agy is write-mode only. The plan layer hard-rejects a
    // read-only dispatch before this runs, but if one ever reaches here, refuse
    // it as a terminal config error rather than running an unsandboxed write.
    if (task.constraints?.sandbox === 'read-only') {
      const message =
        `Agent "${this.name}" cannot run read-only: agy has no enforceable read-only `
        + 'sandbox (absolute paths escape --add-dir/--sandbox and there is no tool-deny '
        + 'policy). Route review/triage to codex (OS sandbox) or claude.';
      logger.error('[adapter:agy] refused read-only dispatch', {
        cwd: task.context.workingDirectory,
      });
      return {
        output: message,
        filesModified: [],
        status: 'error',
        failure: { kind: 'unknown', confidence: 'high', recommendation: 'reroute' },
        metadata: { rawEvents: [{ refused: 'read-only' }] },
      };
    }

    const model = task.constraints?.model;
    // Validate the exact label AT DISPATCH. agy silently answers with its
    // default model on an unknown label, so an unvalidated typo would silently
    // run the wrong model. Validate only when a label is supplied; omit --model
    // entirely otherwise so agy uses its own default.
    if (model !== undefined && !AGY_MODEL_LABEL_SET.has(model)) {
      const message =
        `Unknown agy model label "${model}". agy keys models by exact label; known labels: `
        + `${AGY_MODEL_LABELS.join(', ')}.`;
      logger.error('[adapter:agy] unknown model label', { model });
      return {
        output: message,
        filesModified: [],
        status: 'error',
        failure: { kind: 'unknown', confidence: 'high', recommendation: 'ask_user' },
        metadata: { rawEvents: [{ unknownModel: model }] },
      };
    }

    const args = ['--output-format', 'json'];
    if (model !== undefined) {
      args.push('--model', model);
    }
    // The working directory is a crew-allocated worktree (the planner refuses a
    // working_directory override for agy). --add-dir + --dangerously-skip-
    // permissions are required for agy to write into a real worktree at all;
    // without --add-dir, relative writes are diverted to agy's scratch dir.
    args.push('--add-dir', task.context.workingDirectory);
    args.push('--dangerously-skip-permissions');

    // Resume: continue an existing server-side conversation by id. The id comes
    // from the prior turn's envelope, persisted on run state and threaded here
    // by continue_run. `--continue` (most-recent) is deliberately NOT used — it
    // cross-contaminates concurrent dispatches.
    const resumeSessionId = task.constraints?.resumeSessionId;
    if (resumeSessionId) {
      args.push('--conversation', resumeSessionId);
    }

    // Optional wall-clock budget. When undefined (the crew dispatch default),
    // omit --print-timeout so agy uses its own default and rely on cancelSignal
    // for cancellation. When set, pass it to agy AND give execa a slightly
    // larger hard timeout so agy returns a clean ERROR envelope before execa
    // SIGKILLs it.
    const timeout = task.constraints?.timeout;
    if (timeout) {
      args.push('--print-timeout', `${Math.ceil(timeout / 1000)}s`);
    }

    let result;
    try {
      const subprocess = execa('agy', args, {
        cwd: task.context.workingDirectory,
        ...(timeout ? { timeout: timeout + PRINT_TIMEOUT_EXECA_BUFFER_MS } : {}),
        ...processGroupSpawnOptions(),
        cancelSignal: task.constraints?.signal,
        reject: false,
        // Prompt is delivered on stdin, never argv: it carries untrusted
        // peer_messages/file excerpts, can exceed the argv byte limit, and a
        // leading-dash prompt would be parsed as a flag. `--output-format json`
        // alone triggers headless print mode (no -p needed); passing both -p
        // and stdin would concatenate them.
        input: task.prompt,
      });
      const disposeProcessGroupAbort = terminateProcessGroupOnAbort(
        subprocess,
        task.constraints?.signal,
      );
      try {
        result = await subprocess;
      } finally {
        disposeProcessGroupAbort();
      }
    } catch (error: unknown) {
      const stdoutText = typeof error === 'object' && error && 'stdout' in error
        ? String((error as { stdout?: string }).stdout ?? '')
        : '';
      const stderrText = typeof error === 'object' && error && 'stderr' in error
        ? String((error as { stderr?: string }).stderr ?? '')
        : '';
      const message = error instanceof Error ? error.message : 'Unknown execution error';
      logger.error('[adapter:agy] process execution threw', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        model,
        error: message,
      });
      return {
        output: renderProcessFailureOutput(stdoutText, stderrText, message),
        filesModified: [],
        status: 'error',
        failure: classifyTextFailure(
          [message, stdoutText, stderrText].filter(Boolean).join('\n'),
          { defaultKind: 'process' },
        ),
        metadata: { rawEvents: [{ error: message, stdout: stdoutText, stderr: stderrText }] },
      };
    }

    const stdoutText = result.stdout ?? '';
    const stderrText = result.stderr ?? '';
    const envelope = parseAgyEnvelope(stdoutText);

    // Strict gate: success ONLY when the process exited 0 AND the envelope
    // parsed AND status==="SUCCESS" AND response is non-empty. Anything else is
    // a failure routed through classifyTextFailure — never read a failed or
    // garbled envelope as an empty-but-OK response.
    const succeeded =
      result.exitCode === 0
      && envelope !== null
      && envelope.status === 'SUCCESS'
      && typeof envelope.response === 'string'
      && envelope.response.length > 0;

    if (!succeeded) {
      const failureText =
        envelope?.error
        || [stdoutText, stderrText].filter(Boolean).join('\n')
        || `agy exited with code ${result.exitCode}`;
      return {
        output: failureText,
        filesModified: [],
        status: 'error',
        failure: classifyTextFailure(failureText, { defaultKind: 'process' }),
        metadata: { rawEvents: [{ stdout: stdoutText, stderr: stderrText }] },
      };
    }

    const conversationId = typeof envelope.conversation_id === 'string'
      ? envelope.conversation_id
      : undefined;

    // Silent-reset guard: agy silently starts a FRESH conversation on an
    // unknown/stale id (exit 0 / SUCCESS, no error) — that would be silent
    // context loss on resume. When we asked to resume a specific id, the
    // returned id MUST match; on mismatch, treat the run as invalidated rather
    // than trusting the SUCCESS.
    if (resumeSessionId && conversationId !== resumeSessionId) {
      const message =
        `agy resume invalidated: requested conversation ${resumeSessionId} but the CLI `
        + `returned ${conversationId ?? '(none)'} — it silently started a fresh conversation, `
        + 'so the prior context is lost. Re-dispatch without resume or start a new run.';
      logger.warn('[adapter:agy] resume conversation id mismatch', {
        requested: resumeSessionId,
        returned: conversationId,
      });
      return {
        output: message,
        filesModified: [],
        status: 'error',
        failure: { kind: 'unknown', confidence: 'high', recommendation: 'ask_user' },
        metadata: { rawEvents: [{ stdout: stdoutText }] },
      };
    }

    const output = envelope.response as string;
    if (task.onOutput && output) {
      task.onOutput(output);
    }
    return {
      output,
      filesModified: [],
      status: 'success',
      ...(conversationId ? { sessionId: conversationId } : {}),
      metadata: {
        durationMs: typeof envelope.duration_seconds === 'number'
          ? Math.round(envelope.duration_seconds * 1000)
          : undefined,
        numTurns: typeof envelope.num_turns === 'number' ? envelope.num_turns : undefined,
        rawEvents: [{ stdout: stdoutText, stderr: stderrText }],
      },
    };
  }

  async executeWithSchema<T extends z.ZodType>(
    prompt: string,
    schema: T,
    options?: ExecuteOptions,
  ): Promise<z.infer<T>> {
    const result = await this.execute({
      prompt: `${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(z.toJSONSchema(schema), null, 2)}`,
      context: { workingDirectory: options?.workingDirectory ?? process.cwd() },
      constraints: {
        timeout: options?.timeout,
        model: options?.model,
        signal: options?.signal,
      },
    });
    if (result.status === 'error') {
      throw new Error(result.output || 'agy execution failed.');
    }
    return schema.parse(extractJson(result.output)) as z.infer<T>;
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    try {
      const result = await execa('agy', ['--version'], {
        timeout: 10_000,
        reject: false,
      });
      if (result.exitCode !== 0) {
        return {
          available: false,
          authenticated: false,
          error: result.stderr || 'agy --version failed',
        };
      }
      const combined = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
      const match = combined.match(/(\d+)\.(\d+)\.(\d+)/);
      const parsed = match
        ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
        : null;
      const floor = `${AGY_MIN_VERSION.major}.${AGY_MIN_VERSION.minor}.${AGY_MIN_VERSION.patch}`;
      const versionString = match ? `${match[1]}.${match[2]}.${match[3]}` : result.stdout.trim() || undefined;

      if (!parsed) {
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: `Could not parse agy version; upgrade to ${floor} or later.`,
        };
      }

      if (isAgyVersionBelowFloor(parsed)) {
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: `agy ${versionString} is below the supported floor ${floor}. Upgrade agy; the JSON envelope and headless contract require ${floor}+.`,
        };
      }

      return {
        available: true,
        authenticated: true,
        version: versionString,
      };
    } catch {
      return {
        available: false,
        authenticated: false,
        error: 'agy not found',
      };
    }
  }
}
