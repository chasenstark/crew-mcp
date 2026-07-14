import { promises as fs } from 'node:fs';
import path from 'node:path';
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
  HealthCheckOptions,
  HealthCheckResult,
  Task,
  TaskResult,
} from './types.js';
import { codexSafeSpawnEnvironment } from '../codex/environment.js';

/**
 * `agy` = the Antigravity CLI, Google's replacement for the now-dead
 * gemini-cli individual-auth path. This adapter is intentionally NOT a
 * drop-in for gemini-cli.ts: different binary, flags, model labels, resume
 * mechanism, and write-sandbox behavior. It dispatches in two modes:
 * **write** (implementation, its own crew worktree) and **ephemeral review**
 * (write-capable in a disposable worktree, findings-only, never merged —
 * `reviewDispatchMode: 'ephemeral-worktree'`). An in-place `read_only`
 * dispatch stays hard-rejected — see the reject below and
 * docs/plans/active/agy-readonly-reviewer.md for why agy read-only cannot
 * be enforced.
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
 * agy's built-in print-mode wait defaults to 5m and fires per response wait,
 * not per run: >5m-total multi-turn runs succeed, but a single slow model
 * turn dies with a `timeout waiting for response` ERROR envelope (observed
 * three times at ~300s on heavy review dispatches, 2026-07-07). So when the
 * caller supplies no budget we still pass an explicit --print-timeout with
 * this more patient default instead of inheriting agy's 5m; cancellation in
 * that case stays with cancelSignal + the crew watchdogs (no execa timeout).
 */
const AGY_DEFAULT_PRINT_TIMEOUT_MS = 15 * 60_000;
// agy returns a single JSON envelope, so this adapter intentionally buffers
// stdout. Keep the cap explicit instead of inheriting execa's default.
const AGY_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

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

function isMaxBufferError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'MaxBufferError' || /maxBuffer|buffer/i.test(error.message);
}

/**
 * agy's file-write tool does NOT reliably resolve RELATIVE paths against the
 * process cwd (or `--add-dir`). In a crew-allocated *linked git worktree* it
 * silently diverts relative writes to agy's internal scratch project
 * (~/.gemini/antigravity-cli/scratch), so the deliverable escapes the worktree
 * and crew's git-status probe sees a clean tree — a false SUCCESS. Empirically
 * (agy 1.0.14, macOS): against a real crew worktree, relative-path writes
 * escaped every trial (scratch or the process's own cwd), while ABSOLUTE-path
 * writes under the worktree landed 3/3. `--add-dir` only grants write
 * permission; `--new-project` did NOT help (3/3 scratch in a linked worktree).
 * Absolute paths are the ONLY reliable channel.
 *
 * So we prepend a workspace contract that pins the worktree root and instructs
 * agy to use absolute paths under it for every file/shell operation. This is
 * prompt-level mitigation, not a sandbox (a model can still name an absolute
 * path elsewhere — accepted by the write-mode-only design); the run-agent
 * post-run "write-like success with an empty worktree" warning backstops a
 * slip. Injected in execute() so it applies to fresh dispatch and
 * --conversation resume.
 */
export function withAgyWorkspacePreamble(prompt: string, worktreeRoot: string): string {
  return [
    'Crew workspace contract for this agy run (read first):',
    `- The ONLY writable workspace root for this task is: ${worktreeRoot}`,
    '- Perform EVERY file read, edit, create, or delete, and every shell command,'
      + ' using ABSOLUTE paths under that workspace root.',
    '- Do NOT use relative paths for file operations — even when the task says'
      + ' "current directory", "the repo", "here", or ".". agy silently diverts'
      + ' relative writes to a scratch directory outside the workspace, where they'
      + ' are lost.',
    `- Treat "the current working directory" as exactly this absolute path: ${worktreeRoot}`,
    '- Do NOT create or modify anything outside that workspace root (including any'
      + ' agy scratch or project directory).',
    '',
    prompt,
  ].join('\n');
}

/**
 * Review variant of the workspace contract, selected when the dispatch
 * carries `constraints.reviewIntent` (an `ephemeral_review` run). It REPLACES
 * the write preamble — the two are never stacked, because "write with
 * absolute paths" + "don't write" is a contradiction that makes agy behave
 * unpredictably. The absolute worktree-root pin is RETAINED: agy relies on
 * that injected path to locate files at all (relative reads resolve against
 * the wrong place), so the path half stays and only the behavioral half
 * (write-with-abs-paths → report-findings-only) is swapped. Prompt-level
 * only, not a sandbox: the run's worktree is disposable and its changes are
 * discarded regardless, which is the actual containment.
 */
export function withAgyReviewPreamble(prompt: string, worktreeRoot: string): string {
  return [
    'Crew review contract for this agy run (read first):',
    `- You are REVIEWING the code in this workspace root: ${worktreeRoot}`,
    '- Read files and run inspection commands using ABSOLUTE paths under that'
      + ' workspace root. Do NOT use relative paths — they resolve against the'
      + ' wrong place.',
    `- Treat "the current working directory" as exactly this absolute path: ${worktreeRoot}`,
    '- This is a review, not an implementation task: deliver your findings as'
      + ' TEXT in your response only.',
    '- Do NOT create, edit, or delete any files, and do NOT run mutating shell'
      + ' commands. Any file changes you make will be DISCARDED unread — only'
      + ' the findings you write in your response survive.',
    '',
    prompt,
  ].join('\n');
}

/**
 * Pick the operational preamble for a dispatch: the review contract when the
 * dispatch layer marked review intent (`ephemeral_review`), else the write
 * workspace contract. Exactly one preamble is ever applied.
 */
function withAgyOperationalPreamble(task: Task): string {
  return task.constraints?.reviewIntent === true
    ? withAgyReviewPreamble(task.prompt, task.context.workingDirectory)
    : withAgyWorkspacePreamble(task.prompt, task.context.workingDirectory);
}

export const AGY_MCP_CONFIG_RELPATH = path.join('.agents', 'mcp_config.json');
export const AGY_MCP_QUARANTINE_SUFFIX = '.crew-quarantine';

/**
 * Captain-mode escalation defense. agy has NO MCP allowlist/exclusion flag
 * (verified against agy 1.0.16 `--help`: no MCP-related flag exists), and it
 * loads MCP servers from the project-scoped `<cwd>/.agents/mcp_config.json`.
 * A crew install into agy writes exactly that file, and because it is
 * untracked, worktree sync mirrors it into write worktrees and
 * ephemeral_review snapshots. An agy worker spawned into such a directory
 * boots its own `crew-mcp serve` with the FULL captain tool surface
 * (merge_run / discard_run / run_agent / ...) and
 * `--dangerously-skip-permissions` auto-approves every call — a privilege
 * escalation from worker to captain.
 *
 * Defense: quarantine the file (rename, not delete — a crash leaves the
 * content on disk, recoverable by hand) for the lifetime of the agy
 * subprocess, then restore it. agy reads the config only at startup, so the
 * transient absence is invisible to everything else. If the worker recreated
 * the path mid-run, its version is kept and the quarantine copy is removed so
 * `merge_run` never commits a stray `*.crew-quarantine` file.
 *
 * Returns a restore callback when a config was quarantined, null when none
 * existed. Throws on any other fs failure — callers must FAIL CLOSED (refuse
 * the dispatch) rather than spawn agy with the config still readable.
 */
async function quarantineAgyMcpConfig(
  workingDirectory: string,
): Promise<(() => Promise<void>) | null> {
  const configPath = path.join(workingDirectory, AGY_MCP_CONFIG_RELPATH);
  const quarantinePath = `${configPath}${AGY_MCP_QUARANTINE_SUFFIX}`;
  try {
    await fs.rename(configPath, quarantinePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  logger.warn('[adapter:agy] quarantined project MCP config for worker spawn', {
    configPath,
  });
  return async () => {
    let workerRecreated = true;
    try {
      await fs.access(configPath);
    } catch {
      workerRecreated = false;
    }
    if (workerRecreated) {
      // POSIX rename would clobber the worker's file; keep the worker's
      // version and drop the quarantine copy so it can't leak into a merge.
      await fs.rm(quarantinePath, { force: true });
      logger.warn(
        '[adapter:agy] worker recreated the MCP config during the run; kept the worker version',
        { configPath },
      );
      return;
    }
    try {
      await fs.rename(quarantinePath, configPath);
    } catch (error) {
      logger.error('[adapter:agy] failed to restore quarantined MCP config', {
        quarantinePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}

export class AgyAdapter implements AgentAdapter {
  readonly name = AgentId.AGY;
  // Soft routing hints; users override via ~/.crew/agents.json. These may
  // advertise ephemeral review (findings-only, disposable worktree) but MUST
  // NOT advertise agy as read-only — it cannot honestly enforce read-only.
  readonly strengths: AgentStrength[] = [...BUILTIN_AGENT_ROUTING[AgentId.AGY].strengths];
  readonly useWhen = BUILTIN_AGENT_ROUTING[AgentId.AGY].useWhen;
  // No native JSON-schema support.
  readonly supportsJsonSchema = false;
  // agy CANNOT enforce a read-only filesystem sandbox: absolute paths in a
  // prompt escape any --add-dir/--sandbox, and there is no --policy/tool-deny
  // equivalent to gemini's. So read-only is not "weakly enforced" — it is
  // refused outright (rejectsReadOnly). enforcesReadOnly stays false.
  readonly enforcesReadOnly = false;
  // An in-place read_only dispatch is hard-rejected fail-closed at the plan
  // layer (planRunAgent) so the run never starts; this flag is what that layer
  // keys on. Reviews route through run_mode:'ephemeral_review' instead (below).
  readonly rejectsReadOnly = true;
  // Reviews run write-capable inside a crew-allocated DISPOSABLE worktree
  // (run_mode:'ephemeral_review'): only text findings are kept, the run is
  // never mergeable, and the worktree is reclaimed by discard/GC. Containment
  // is disposal, not denial — agy cannot honestly enforce read-only. Keep in
  // lockstep with BUILTIN_ADAPTER_METADATA in registry.ts (proxy/instance
  // parity).
  readonly reviewDispatchMode = 'ephemeral-worktree' as const;
  // A write dispatch must run inside its own crew-allocated worktree. The
  // planner refuses a working_directory override for agy so an untrusted prompt
  // can't redirect writes outside the isolated worktree.
  readonly requiresCrewWorktree = true;
  // agy terminal execution has no file-change stream → run-agent's worktree
  // git-status fallback is the source of truth for filesModified.
  readonly filesModifiedReliable = false;
  readonly supportsResume = true;
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && AGY_MODEL_LABEL_SET.has(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('agy', ['--version'], {
      ...codexSafeSpawnEnvironment(),
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

    // Wall-clock budget. Always pass an explicit --print-timeout: the
    // caller's budget when set, else AGY_DEFAULT_PRINT_TIMEOUT_MS — agy's own
    // 5m default kills slow single turns (see the constant's doc). Only a
    // caller-supplied budget also gets an execa hard timeout (slightly above,
    // so agy returns a clean ERROR envelope before execa SIGKILLs it); the
    // default case relies on cancelSignal + crew watchdogs.
    const timeout = task.constraints?.timeout;
    args.push('--print-timeout', `${Math.ceil((timeout ?? AGY_DEFAULT_PRINT_TIMEOUT_MS) / 1000)}s`);

    // Quarantine any project-scoped MCP config before spawning; fail closed
    // when the quarantine itself fails — never run agy with crew captain
    // tools reachable (see quarantineAgyMcpConfig).
    let restoreMcpConfig: (() => Promise<void>) | null = null;
    try {
      restoreMcpConfig = await quarantineAgyMcpConfig(task.context.workingDirectory);
    } catch (error: unknown) {
      const message =
        `agy dispatch refused: could not quarantine ${AGY_MCP_CONFIG_RELPATH} in the `
        + 'working directory, so the worker would inherit the crew captain MCP tool '
        + 'surface with --dangerously-skip-permissions. Underlying error: '
        + `${error instanceof Error ? error.message : String(error)}`;
      logger.error('[adapter:agy] MCP config quarantine failed; refusing dispatch', {
        cwd: task.context.workingDirectory,
      });
      return {
        output: message,
        filesModified: [],
        status: 'error',
        failure: { kind: 'process', confidence: 'high', recommendation: 'ask_user' },
        metadata: { rawEvents: [{ refused: 'mcp-config-quarantine-failed' }] },
      };
    }
    try {
      return await this.spawnAndParse(task, args, model, timeout, resumeSessionId);
    } finally {
      if (restoreMcpConfig) await restoreMcpConfig();
    }
  }

  private async spawnAndParse(
    task: Task,
    args: string[],
    model: string | undefined,
    timeout: number | undefined,
    resumeSessionId: string | undefined,
  ): Promise<TaskResult> {
    let result;
    try {
      const subprocess = execa('agy', args, {
        ...codexSafeSpawnEnvironment(),
        cwd: task.context.workingDirectory,
        ...(timeout ? { timeout: timeout + PRINT_TIMEOUT_EXECA_BUFFER_MS } : {}),
        maxBuffer: AGY_MAX_BUFFER_BYTES,
        ...processGroupSpawnOptions(),
        cancelSignal: task.constraints?.signal,
        reject: false,
        // Prompt is delivered on stdin, never argv: it carries untrusted
        // peer_messages/file excerpts, can exceed the argv byte limit, and a
        // leading-dash prompt would be parsed as a flag. `--output-format json`
        // alone triggers headless print mode (no -p needed); passing both -p
        // and stdin would concatenate them. The operational preamble pins the
        // absolute worktree root (agy needs it to locate files) and carries
        // either the write contract or, for ephemeral reviews, the
        // findings-only review contract (see withAgyOperationalPreamble).
        input: withAgyOperationalPreamble(task),
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
      const capMessage = isMaxBufferError(error)
        ? `agy output exceeded the configured ${AGY_MAX_BUFFER_BYTES} byte maxBuffer cap`
        : undefined;
      logger.error('[adapter:agy] process execution threw', {
        cwd: task.context.workingDirectory,
        timeoutMs: timeout,
        model,
        error: capMessage ?? message,
      });
      return {
        output: capMessage ?? renderProcessFailureOutput(stdoutText, stderrText, message),
        filesModified: [],
        status: 'error',
        failure: classifyTextFailure(
          [capMessage ?? message, stdoutText, stderrText].filter(Boolean).join('\n'),
          { defaultKind: 'process' },
        ),
        metadata: { rawEvents: [{ error: capMessage ?? message, stdout: stdoutText, stderr: stderrText }] },
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
      },
    };
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    try {
      const result = await execa('agy', ['--version'], {
        ...codexSafeSpawnEnvironment(),
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
