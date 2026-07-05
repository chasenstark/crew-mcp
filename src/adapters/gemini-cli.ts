import { execa } from 'execa';
import { z } from 'zod';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { extractJson } from '../utils/json-parse.js';
import { HealthCheckCache } from '../utils/health-check-cache.js';
import { BUILTIN_AGENT_ROUTING } from './strengths.js';
import {
  logBestEffortFailure,
  registerTempDirForCleanup,
  unregisterTempDirForCleanup,
} from '../utils/best-effort.js';
import { logger } from '../utils/logger.js';
import { buildCliVersionTag } from '../provider-session.js';
import { AgentId } from '../workflow/agents.js';
import {
  processGroupSpawnOptions,
  terminateProcessGroupOnAbort,
} from './process-group.js';
import { classifyTextFailure } from './failure-classifier.js';
import {
  assertArgvPromptWithinLimit,
} from './prompt-transport.js';
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
 * Event shapes emitted by `gemini -o stream-json`. The CLI prints one JSON
 * object per newline-terminated line with a discriminated `type` field.
 *
 *   init    — { type: 'init', session_id: '<uuid>' }  (always the first line on a fresh session)
 *   message — { type: 'message', role: 'assistant'|'user', content?: string, delta?: string }
 *   result  — { type: 'result', stats?: {...}, ... }   (last line; summary)
 *
 * The CLI additionally emits an assistant `message` on resume turns
 * containing a `--prompt (-p) flag has been deprecated` notice. We filter
 * those out before accumulating assistant text — otherwise the captain
 * would see the deprecation warning as part of its reply.
 */
export type GeminiEventType = 'init' | 'message' | 'result';

export interface GeminiEvent {
  type?: GeminiEventType | string;
  session_id?: string;
  role?: 'user' | 'assistant' | 'system';
  content?: string;
  text?: string;
  message?: string;
  delta?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Parses `-o stream-json` output into its newline-delimited JSON events.
 * Malformed or non-object lines are logged and dropped. Exported for the
 * dedicated parser tests; end-to-end callers go through the adapter.
 */
export function parseStreamJsonEvents(stdout: string): GeminiEvent[] {
  const events: GeminiEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        events.push(parsed as GeminiEvent);
      } else {
        logger.warn('[adapter:gemini-cli] dropped non-object JSON line');
      }
    } catch {
      logger.warn('[adapter:gemini-cli] dropped malformed JSON line');
    }
  }
  return events;
}

/**
 * Parses `-o json` output, which is a single JSON object like
 * `{response: string, stats: {...}}`. Returns the response text, or an empty
 * string if the shape is unexpected.
 */
export function parseSingleJsonResponse(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const maybe = (parsed as { response?: unknown }).response;
      if (typeof maybe === 'string') return maybe;
    }
  } catch {
    logger.warn('[adapter:gemini-cli] -o json output was not valid JSON');
  }
  return '';
}

/**
 * Gemini emits this exact assistant-role line on resume turns. It must be
 * filtered out before being surfaced to the captain.
 */
const GEMINI_DEPRECATION_FRAGMENT = '--prompt (-p) flag has been deprecated';

export function isGeminiDeprecationNotice(content: string | undefined): boolean {
  return typeof content === 'string' && content.includes(GEMINI_DEPRECATION_FRAGMENT);
}

/**
 * Extracts the session id from a stream-json event stream. The `init` event
 * emitted on a fresh or resumed session carries it.
 */
export function extractStreamJsonSessionId(events: GeminiEvent[]): string | undefined {
  for (const event of events) {
    if (event.type === 'init' && typeof event.session_id === 'string' && event.session_id.length > 0) {
      return event.session_id;
    }
  }
  for (const event of events) {
    if (typeof event.session_id === 'string' && event.session_id.length > 0) {
      return event.session_id;
    }
  }
  return undefined;
}

/**
 * Accumulates assistant text from stream-json `message` events. Handles both
 * full-content and delta-chunk shapes, drops the deprecation notice, and
 * returns an empty string when no assistant text was produced.
 *
 * The deprecation notice is filtered in two passes: (1) whole-message
 * `content` events that equal/contain the notice are skipped outright, and
 * (2) the final concatenation is post-scrubbed to catch cases where Gemini
 * streams the notice as a sequence of deltas instead of a single content
 * event. Both paths are exercised by the parser tests.
 */
export function extractStreamJsonAssistantText(events: GeminiEvent[]): string {
  const chunks: string[] = [];
  for (const event of events) {
    if (event.type !== 'message') continue;
    if (event.role && event.role !== 'assistant') continue;

    const content = typeof event.content === 'string' ? event.content : undefined;
    const delta = typeof event.delta === 'string' ? event.delta : undefined;

    if (content) {
      if (isGeminiDeprecationNotice(content)) continue;
      chunks.push(content);
      continue;
    }
    if (delta) {
      chunks.push(delta);
    }
  }
  return stripDeprecationNoticeSentences(chunks.join(''));
}

function stripDeprecationNoticeSentences(text: string): string {
  if (!text.includes(GEMINI_DEPRECATION_FRAGMENT)) return text;
  // Drop the entire sentence/line that contains the notice. We remove
  // characters up to (and including) the nearest terminating punctuation or
  // newline after the fragment so a stray "<prefix>... deprecated." doesn't
  // leak into the assistant's actual reply.
  return text.replace(
    /[^.\n]*--prompt \(-p\) flag has been deprecated[^.\n]*[.\n]?/g,
    '',
  ).trim();
}

function renderProcessFailureOutput(stdout: string, stderr: string, message: string): string {
  if (stderr) return stderr;
  if (stdout) return stdout;
  return message;
}

function isMaxBufferError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'MaxBufferError' || /maxBuffer|buffer/i.test(error.message);
}

/**
 * Minimum Gemini CLI version eligible for the captain role. Resume-by-UUID
 * is flaky in < 0.20 per upstream issues #24808/#24532/#24535; healthCheck
 * rejects older releases so users see a clear error instead of a mystery
 * mid-run failure.
 */
export const GEMINI_MIN_VERSION = { major: 0, minor: 20, patch: 0 } as const;
// Gemini terminal dispatch returns a single JSON envelope, so this adapter
// intentionally buffers stdout. Keep the cap explicit and diagnosable.
const GEMINI_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Gemini built-in tools that can mutate the working tree or VCS state.
 * Denied per-run (via a generated `--policy` file) on read_only dispatches
 * so a dispatched reviewer cannot write files or commit. This is the exact
 * set proven to block writes end-to-end against the real CLI (gemini refuses
 * the tool call): `write_file`/`replace` are its file-mutation tools and
 * `run_shell_command` covers `git commit`, `rm`, `mv`, `sed`, and any other
 * shell-driven write. We list ONLY tool names known to exist in supported CLI
 * versions — an unknown name risks a policy-load error.
 *
 * Test coverage of this list is split and has a known gap: the gated live test
 * (CREW_GEMINI_LIVE) proves the policy MECHANISM end-to-end for `write_file`
 * (real binary refuses the call), and the unit test asserts every entry here is
 * present in the rendered TOML. Neither catches a CLI tool RENAME (e.g. if a
 * future version renames `run_shell_command`) — that would silently leave the
 * old name denied and the new one allowed. If the CLI renames or adds a mutate
 * tool, update this list AND the live test together.
 */
export const GEMINI_READ_ONLY_DENIED_TOOLS = [
  'write_file',
  'replace',
  'run_shell_command',
  // save_memory persists to a GEMINI.md memory file. It is not a working-tree
  // edit (and so is out of the dirty-tree probe's scope), but it IS a mutation
  // a review should not perform, and the tool name is real in supported CLI
  // versions, so denying it is safe and closes the gap.
  'save_memory',
] as const;

/**
 * Renders the TOML policy passed to `gemini --policy <file>` on read_only
 * dispatches. One `[[rule]]` per denied tool with `priority = 999` so the
 * deny wins over any allow in the user's global/user-tier policy. String
 * (not array) `toolName` mirrors the exact form verified against the real CLI.
 */
export function renderReadOnlyPolicyToml(): string {
  const header = [
    '# Crew read-only review policy for the Gemini CLI (auto-generated per run).',
    '# Denies the tools that mutate the working tree or VCS so a dispatched',
    '# reviewer cannot write files or commit. Tool-level denial — not an OS',
    '# filesystem sandbox; the dispatch layer also runs a dirty-tree probe.',
  ].join('\n');
  const rules = GEMINI_READ_ONLY_DENIED_TOOLS.map(
    (tool) => `[[rule]]\ntoolName = "${tool}"\ndecision = "deny"\npriority = 999`,
  ).join('\n\n');
  return `${header}\n\n${rules}\n`;
}

/**
 * Returns the argv fragment for a `gemini -o stream-json` resume invocation.
 * The prompt is passed via `--prompt` (not positional) on resume turns; seed
 * turns use positional since no `--resume` target exists yet.
 *
 * When the session-loop supplies an `allowedServerNames` list (via
 * `McpRegistrationPayload.kind === 'gemini-cli'`), the flag
 * `--allowed-mcp-server-names <csv>` is appended. Empty list → no flag so
 * argv stays clean when the catalog has no servers.
 */
export function buildGeminiResumeArgs(
  sessionId: string | undefined,
  prompt: string,
  options?: { readonly allowedServerNames?: readonly string[] },
): string[] {
  const base: string[] = sessionId
    ? ['-o', 'stream-json', '--resume', sessionId, '--prompt', prompt]
    : ['-o', 'stream-json', prompt];
  const allowed = options?.allowedServerNames;
  if (allowed && allowed.length > 0) {
    // Allowed-names is a flag that precedes any positional prompt; we
    // prepend it to the stream-json options to keep the prompt at the tail
    // for both seed and resume calls.
    return injectAllowedMcpNames(base, allowed);
  }
  return base;
}

function injectAllowedMcpNames(
  args: string[],
  allowed: readonly string[],
): string[] {
  // Insert after `-o stream-json` so the prompt (positional or via --prompt)
  // stays at the end.
  const out = [...args];
  const csv = allowed.join(',');
  // Find index right after `stream-json` token.
  const idx = out.findIndex((t, i) => t === 'stream-json' && out[i - 1] === '-o');
  const insertAt = idx === -1 ? 0 : idx + 1;
  out.splice(insertAt, 0, '--allowed-mcp-server-names', csv);
  return out;
}

export function isInvalidSessionStderr(stderr: string): boolean {
  if (!stderr) return false;
  return /invalid session identifier/i.test(stderr);
}

export function isVersionBelowFloor(
  parsed: { major: number; minor: number; patch: number } | null,
): boolean {
  if (!parsed) return true;
  if (parsed.major < GEMINI_MIN_VERSION.major) return true;
  if (parsed.major > GEMINI_MIN_VERSION.major) return false;
  if (parsed.minor < GEMINI_MIN_VERSION.minor) return true;
  if (parsed.minor > GEMINI_MIN_VERSION.minor) return false;
  return parsed.patch < GEMINI_MIN_VERSION.patch;
}

export class GeminiCliAdapter implements AgentAdapter {
  readonly name = AgentId.GEMINI_CLI;
  // Soft routing hints; users override via ~/.crew/agents.json.
  // See AgentStrength docs in src/adapters/types.ts.
  readonly strengths: AgentStrength[] = [...BUILTIN_AGENT_ROUTING['gemini-cli'].strengths];
  readonly useWhen = BUILTIN_AGENT_ROUTING['gemini-cli'].useWhen;
  // Gemini CLI has no native schema-enforcement flag; executeWithSchema
  // post-validates with Zod. Reporting false makes downstream code pick the
  // right branch (prompt-based structured output instead of native schema).
  readonly supportsJsonSchema = false;
  // Read-only is enforced at the TOOL level on read_only dispatches: execute()
  // generates a per-run `--policy` file that denies write_file/replace/
  // run_shell_command. That is NOT an OS filesystem sandbox, which is what
  // `enforcesReadOnly` specifically reports (see types.ts), so it stays false:
  // the dispatch layer keeps its dirty-tree probe as a backstop and surfaces a
  // tool-policy advisory. See execute() + renderReadOnlyPolicyToml().
  readonly enforcesReadOnly = false;
  // Reviews run in place via the read_only dispatch path (tool-level policy
  // deny, see above). Keep in lockstep with BUILTIN_ADAPTER_METADATA in
  // registry.ts (proxy/instance parity).
  readonly reviewDispatchMode = 'read-only-dispatch' as const;
  // Gemini terminal execution does not currently parse a file-change stream.
  readonly filesModifiedReliable = false;
  readonly captainCapabilities = {
    supportsToolLoop: false,
    supportsStructuredDecisions: true,
    supportsPauseForUserInput: false,
  };
  private readonly healthCheckCache = new HealthCheckCache();

  recognizesModel(modelId: string): boolean {
    return typeof modelId === 'string' && /^(gemini|qwen)/i.test(modelId);
  }

  async getCliVersionTag(): Promise<string | undefined> {
    const result = await execa('gemini', ['--version'], {
      timeout: 10_000,
      reject: false,
    });
    if (result.exitCode !== 0) return undefined;
    const match = `${result.stdout ?? ''} ${result.stderr ?? ''}`.match(/(\d+\.\d+\.\d+)/);
    if (!match) return undefined;
    return buildCliVersionTag(AgentId.GEMINI_CLI, match[1]);
  }

  async execute(task: Task): Promise<TaskResult> {
    // Resume is deliberately unwired here: this gemini-cli dispatch path is
    // auth-dead in production and should not silently pretend to continue.
    const args = ['--output-format', 'json'];
    if (task.constraints?.model) {
      args.push('--model', task.constraints.model);
    }

    // Read-only dispatches (review/triage) are enforced at the tool level: we
    // write a per-run policy that denies Gemini's file-write and shell tools
    // and pass it via `--policy`. The signal arrives as `constraints.sandbox`,
    // set to 'read-only' by run-agent.ts for read_only runs (mirrors how codex
    // reads `--sandbox`). Unlike codex this is tool denial, not an OS sandbox —
    // the dispatch layer keeps its dirty-tree probe as a backstop.
    const readOnly = task.constraints?.sandbox === 'read-only';
    // Trust is scoped UPSTREAM (run-agent sets trustWorkspace only for
    // crew-controlled paths). We never derive it from readOnly here, because
    // trusting a folder loads its project config and is unsafe on arbitrary
    // dirs — see the env comment below and Task.constraints.trustWorkspace.
    const trustWorkspace = task.constraints?.trustWorkspace === true;
    let policyTmpDir: string | undefined;
    if (readOnly) {
      try {
        policyTmpDir = mkdtempSync(join(tmpdir(), 'gemini-policy-'));
        registerTempDirForCleanup(policyTmpDir);
        const policyFile = join(policyTmpDir, 'review-only.toml');
        writeFileSync(policyFile, renderReadOnlyPolicyToml(), 'utf-8');
        args.push('--policy', policyFile);
      } catch (error: unknown) {
        // Fail CLOSED: a read-only review must never run without the deny
        // policy. If we can't write it, error out instead of dispatching an
        // unprotected reviewer.
        if (policyTmpDir) {
          try {
            rmSync(policyTmpDir, { recursive: true, force: true });
            unregisterTempDirForCleanup(policyTmpDir);
          } catch (err) {
            logBestEffortFailure('gemini.policy-tmp-cleanup', err);
          }
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.error('[adapter:gemini-cli] failed to write read-only policy file', {
          cwd: task.context.workingDirectory,
          error: message,
        });
        return {
          output: `Failed to write Gemini read-only policy file: ${message}`,
          filesModified: [],
          status: 'error',
          metadata: { rawEvents: [{ error: message }] },
        };
      }
    }

    // The prompt is delivered via stdin, never argv. Gemini reads a piped
    // (non-TTY) stdin as the prompt, and `--output-format json` forces
    // headless mode. Argv delivery is wrong here on three counts: the prompt
    // carries untrusted peer_messages/file excerpts, it can exceed the argv
    // byte limit, and a leading-dash prompt would be parsed as a flag. A `--`
    // separator does NOT help — Gemini's parser routes post-`--` tokens into
    // its passthrough array rather than the prompt positional, so the CLI
    // receives no input and exits. Mirrors the codex/claude-code stdin
    // transport.

    // No wall-clock timeout (was 300_000). Cancellation flows through
    // the captain-supplied cancelSignal; the agent's own budget caps
    // runaway turns.
    const timeout = task.constraints?.timeout;

    try {
      let result;
      try {
        const subprocess = execa('gemini', args, {
          cwd: task.context.workingDirectory,
          ...(timeout ? { timeout } : {}),
          maxBuffer: GEMINI_MAX_BUFFER_BYTES,
          ...processGroupSpawnOptions(),
          cancelSignal: task.constraints?.signal,
          reject: false,
          input: task.prompt,
          // Crew dispatches non-interactively into dirs Gemini hasn't been told
          // to trust; without trust, headless runs abort at the folder-trust
          // gate. We only force trust for crew-controlled paths (trustWorkspace,
          // set upstream) — NOT a blanket read-only grant. This matters because
          // trusting a folder also loads its project `.gemini` settings/MCP/
          // hooks/.env, which execute OUTSIDE the deny policy (the policy only
          // blocks the model's own write_file/replace/run_shell_command/
          // save_memory tools). Auto-trusting an arbitrary review target would
          // reopen that vector.
          //
          // We set the var EXPLICITLY ('true'|'false') rather than only adding
          // it when trusting: execa merges env over process.env (extendEnv
          // default true), so a captain process that already exported
          // GEMINI_CLI_TRUST_WORKSPACE=true would otherwise leak trust into an
          // external review dir we computed as untrusted. Gemini reads the var
          // strictly as `=== 'true'` (verified), so 'false' forces untrusted.
          ...(readOnly
            ? { env: { GEMINI_CLI_TRUST_WORKSPACE: trustWorkspace ? 'true' : 'false' } }
            : {}),
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
        const message =
          error instanceof Error ? error.message : 'Unknown execution error';
        const capMessage = isMaxBufferError(error)
          ? `gemini-cli output exceeded the configured ${GEMINI_MAX_BUFFER_BYTES} byte maxBuffer cap`
          : undefined;
        logger.error('[adapter:gemini-cli] process execution threw', {
          cwd: task.context.workingDirectory,
          timeoutMs: timeout,
          model: task.constraints?.model,
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
          metadata: {
            rawEvents: [
              {
                error: capMessage ?? message,
                stdout: stdoutText,
                stderr: stderrText,
              },
            ],
          },
        };
      }

      const stdoutText = result.stdout ?? '';
      const stderrText = result.stderr ?? '';
      const output = parseSingleJsonResponse(stdoutText);
      if (task.onOutput && output) {
        task.onOutput(output);
      }
      return {
        output: output || stderrText,
        filesModified: [],
        status: result.exitCode === 0 ? 'success' : 'error',
        ...(result.exitCode === 0
          ? {}
          : {
              failure: classifyTextFailure(
                [stdoutText, stderrText].filter(Boolean).join('\n')
                  || `gemini exited with code ${result.exitCode}`,
                { defaultKind: 'process' },
              ),
            }),
        metadata: {
          rawEvents: [{ stdout: stdoutText, stderr: stderrText }],
        },
      };
    } finally {
      if (policyTmpDir) {
        try {
          rmSync(policyTmpDir, { recursive: true, force: true });
          unregisterTempDirForCleanup(policyTmpDir);
        } catch (err) {
          logBestEffortFailure('gemini.policy-tmp-cleanup', err);
        }
      }
    }
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
      throw new Error(result.output || 'Gemini CLI execution failed.');
    }
    return schema.parse(extractJson(result.output)) as z.infer<T>;
  }

  async healthCheck(options?: HealthCheckOptions): Promise<HealthCheckResult> {
    return this.healthCheckCache.get(options, () => this.probeHealth());
  }

  private async probeHealth(): Promise<HealthCheckResult> {
    try {
      const result = await execa('gemini', ['--version'], {
        timeout: 10_000,
        reject: false,
      });
      if (result.exitCode !== 0) {
        return {
          available: false,
          authenticated: false,
          error: result.stderr || 'gemini --version failed',
        };
      }
      const combined = `${result.stdout ?? ''} ${result.stderr ?? ''}`;
      const match = combined.match(/(\d+)\.(\d+)\.(\d+)/);
      const parsed = match
        ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
        : null;
      const versionString = match ? `${match[1]}.${match[2]}.${match[3]}` : result.stdout.trim() || undefined;

      if (!parsed) {
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: 'Could not parse Gemini CLI version; upgrade to 0.20.0 or later.',
        };
      }

      if (isVersionBelowFloor(parsed)) {
        const floor = `${GEMINI_MIN_VERSION.major}.${GEMINI_MIN_VERSION.minor}.${GEMINI_MIN_VERSION.patch}`;
        return {
          available: false,
          authenticated: false,
          version: versionString,
          error: `Gemini CLI ${versionString} is below the supported floor ${floor}. Upgrade gemini-cli; resume is unstable on earlier releases.`,
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
        error: 'Gemini CLI not found',
      };
    }
  }

}
