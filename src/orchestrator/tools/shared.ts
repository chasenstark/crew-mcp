import { pathToFileURL } from 'node:url';

import type { AdapterRegistry } from '../../adapters/registry.js';
import type { AgentPrefsMap } from '../../agent-prefs/store.js';
import type { WorktreeManager } from '../../git/worktree.js';
import { crewTailUrl } from '../../cli/commands/tail-url.js';
import { logger } from '../../utils/logger.js';
import {
  installRunLifecycleListeners,
} from '../run-lifecycle-listeners.js';
import type { RunStateStore, RunStateV1 } from '../run-state.js';
import type { DispatchTask, ToolDispatcher } from '../tool-dispatcher.js';
import type { ProgressNotifier } from '../progress.js';
import type { QuotaSnapshot } from './list-agents.js';

/**
 * Server-side cap on the long-poll wait that `get_run_status` honors
 * via `wait_for_change_ms`. Kept under the smallest known host MCP
 * tool-call timeout so a long-poll never trips the host's own deadline.
 * Captains usually pass 30000; we clamp anything larger to this value.
 */
export const MAX_LONG_POLL_MS = 60_000;

/**
 * Classification of the MCP host CLI that initialized this server, derived
 * from the `clientInfo.name` carried in the MCP `initialize` request. Used
 * to tailor the dispatch envelope's "next step" copy: Claude Code captains
 * spawn a background-shell watcher, while Codex captains start a deferred
 * code-mode watcher that yields control before waiting.
 */
export type ClientKind = 'claude-code' | 'codex' | 'codex-legacy' | 'unknown';

export const MIN_CODEX_DEFERRED_WATCHER_VERSION = '0.144.1';

/**
 * Map an MCP `clientInfo.name` string to a `ClientKind`. Substring match
 * (not equality) so future renames of host clients still classify
 * correctly without re-shipping crew-mcp. Normalizes separators
 * (whitespace, underscores -> hyphens) and case before matching so
 * `"Claude Code"`, `"claude_code"`, and `"claude-code-cli"` all fold
 * to the same kind.
 */
export function classifyClient(
  name: string | undefined,
  version?: string,
): ClientKind {
  if (!name) return 'unknown';
  const n = name.toLowerCase().replace(/[\s_]+/g, '-');
  if (n.includes('claude-code') || n === 'claude') return 'claude-code';
  if (n.includes('codex')) {
    return supportsCodexDeferredWatcher(version) ? 'codex' : 'codex-legacy';
  }
  return 'unknown';
}

export function supportsCodexDeferredWatcher(version: string | undefined): boolean {
  const actual = parseNumericVersion(version);
  const minimum = parseNumericVersion(MIN_CODEX_DEFERRED_WATCHER_VERSION)!;
  if (actual === undefined) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const delta = (actual[index] ?? 0) - minimum[index];
    if (delta !== 0) return delta > 0;
  }
  return true;
}

function parseNumericVersion(version: string | undefined): number[] | undefined {
  if (!version) return undefined;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

/**
 * Host-specific "next step" sentence appended to the dispatch envelope
 * summary and the markdown `- Next:` bullet.
 */
export function nextStepSentence(kind: ClientKind, watcherAvailable = true): string {
  switch (kind) {
    case 'claude-code':
      return watcherAvailable
        ? 'One required action: spawn the crew-wait watcher before ending your turn; user is free to chat.'
        : 'The crew-wait watcher is unavailable; end your turn and recover terminal state on the next user turn.';
    case 'codex':
      return watcherAvailable
        ? 'One required action: start the deferred crew-wait watcher and yield control before ending your turn; user is free to chat.'
        : 'The installed Codex watcher command is unavailable or untrusted; end your turn and recover terminal state on the next user turn.';
    case 'codex-legacy':
      return `This Codex version lacks the deferred watcher (requires ${MIN_CODEX_DEFERRED_WATCHER_VERSION}+); end your turn and recover terminal state on the next user turn.`;
    case 'unknown':
      return 'End your turn after dispatch; user is free to chat.';
  }
}

export function agentIdForClientKind(kind: ClientKind): string | undefined {
  switch (kind) {
    case 'claude-code':
      return 'claude-code';
    case 'codex':
    case 'codex-legacy':
      return 'codex';
    case 'unknown':
      return undefined;
  }
}

export type RunStatus = 'running' | 'success' | 'partial' | 'error' | 'cancelled';

export interface RunEnvelope {
  readonly run_id: string;
  readonly tail_url: string;
  readonly summary: string;
  readonly files_changed: readonly string[];
  readonly required_next_action?: RequiredNextAction;
  readonly warnings?: readonly string[];
  readonly status?: RunStatus;
  readonly agent_id?: string;
  readonly worktree_path?: string;
  readonly events_log_path?: string;
  readonly tail_command_path?: string;
  readonly tail_command_url?: string;
}

export interface FullRunEnvelope extends RunEnvelope {
  readonly status: RunStatus;
  readonly agent_id?: string;
  readonly worktree_path: string;
  readonly events_log_path: string;
  readonly tail_command_path: string;
  readonly tail_command_url: string;
}

export interface RequiredNextAction {
  readonly type: 'spawn_watcher';
  readonly mechanism: 'background_shell' | 'deferred_code';
  readonly command: string;
  /** JSON string literal safe to paste directly into deferred JavaScript. */
  readonly command_json: string;
  /** JSON array literal safe to paste directly into deferred JavaScript. */
  readonly run_ids_json: string;
  /** Working directory used by the watcher command. */
  readonly working_directory: string;
  /** JSON string literal safe to paste directly into deferred JavaScript. */
  readonly working_directory_json: string;
  readonly run_id?: string;
  readonly run_ids?: readonly string[];
  readonly run_in_background: true;
  readonly per_run: boolean;
  readonly consequence_if_skipped: string;
}

export interface MergeEnvelope {
  readonly run_id: string;
  readonly status: 'merged' | 'conflict' | 'no-changes';
  readonly commit_sha?: string;
  readonly conflicts?: readonly string[];
  readonly target_branch?: string;
  readonly original_branch?: string;
  readonly original_head?: string;
  readonly landed_off_current_branch?: boolean;
  readonly restore_failed?: boolean;
  readonly restore_warning?: string;
}

export interface DiscardEnvelope {
  readonly run_id: string;
  readonly ok: true;
  readonly cleanup_failed?: true;
  readonly cleanup_errors?: readonly string[];
}

export type ToolCallReturn = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface ProgressTokenSeen {
  presentLogged: boolean;
  absentLogged: boolean;
  lastObserved?: 'present' | 'absent';
}

export type ToolRequestExtra = {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: {
    method: 'notifications/progress';
    params: { progressToken: string | number; progress: number; message?: string };
  }) => Promise<void>;
};

export interface ToolHandlerDeps {
  readonly registry: AdapterRegistry;
  readonly worktreeManager: WorktreeManager;
  readonly runStateStore: RunStateStore;
  readonly dispatcher: ToolDispatcher;
  readonly crewHome: string;
  readonly projectRoot: string;
  readonly getClientKind: () => ClientKind;
  readonly getCrewWaitCommand: () => string | undefined;
  readonly progressTokenSeen: ProgressTokenSeen;
  readonly captainServeInstance?: string;
  readonly readAgentPrefs: () => AgentPrefsMap;
  readonly quotaProbe?: (agentName: string) => Promise<QuotaSnapshot | undefined>;
  readonly clearQuotaCache?: () => void;
  readonly onTerminalPersisted?: (state: RunStateV1) => void | Promise<void>;
}

interface DispatchAndRespondArgs {
  runId: string;
  agentName: string;
  worktreePath: string;
  toolCallId: string;
  task: DispatchTask;
  dispatcher: ToolDispatcher;
  runStateStore: RunStateStore;
  warnings?: readonly string[];
  progress?: ProgressNotifier;
  onStartFailure?: (err: unknown) => Promise<Error>;
  onDispatchStarted?: () => void;
  onTerminalPersisted?: (state: RunStateV1) => void | Promise<void>;
  clientKind: ClientKind;
  crewWaitCommand?: string;
  crewHome: string;
  projectRoot: string;
}

export async function runDispatchAndRespond(
  args: DispatchAndRespondArgs,
): Promise<ToolCallReturn> {
  void installRunLifecycleListeners({
    dispatcher: args.dispatcher,
    runStateStore: args.runStateStore,
    runId: args.runId,
    agentName: args.agentName,
    toolCallId: args.toolCallId,
    progress: args.progress,
    onTerminalPersisted: args.onTerminalPersisted,
  });
  try {
    args.dispatcher.start(args.task);
    args.onDispatchStarted?.();
  } catch (err) {
    if (args.onStartFailure) {
      throw await args.onStartFailure(err);
    }
    throw err;
  }

  const summary = `Dispatched as "${args.runId}". ${nextStepSentence(
    args.clientKind,
    args.crewWaitCommand !== undefined,
  )}`;
  const eventsLogPath = args.runStateStore.eventsLogPath(args.runId);
  const tailCommandPath = args.runStateStore.tailCommandPath(args.runId);
  const requiredNextAction = requiredNextActionForRun(
    args.clientKind,
    args.crewWaitCommand,
    args.runId,
    args.crewHome,
    args.projectRoot,
  );
  const env: FullRunEnvelope = {
    run_id: args.runId,
    agent_id: args.agentName,
    worktree_path: args.worktreePath,
    events_log_path: eventsLogPath,
    tail_command_path: tailCommandPath,
    tail_command_url: fileUrlHref(tailCommandPath),
    tail_url: crewTailUrl(eventsLogPath),
    status: 'running',
    summary,
    files_changed: [],
    ...(requiredNextAction !== undefined ? { required_next_action: requiredNextAction } : {}),
    ...mergeEnvelopeWarnings(
      args.runStateStore.read(args.runId)?.warnings,
      args.warnings,
    ),
  };
  return {
    content: [{ type: 'text' as const, text: renderDispatchMarkdown(env, args.clientKind) }],
    structuredContent: structuredRunEnvelope(env) as unknown as Record<string, unknown>,
  };
}

export function structuredRunEnvelope(env: FullRunEnvelope): RunEnvelope {
  if (process.env.CREW_FULL_ENVELOPE === '1') {
    return env;
  }
  return {
    run_id: env.run_id,
    tail_url: env.tail_url,
    summary: env.summary,
    files_changed: env.files_changed,
    ...(env.required_next_action !== undefined
      ? { required_next_action: env.required_next_action }
      : {}),
    ...(env.warnings !== undefined ? { warnings: env.warnings } : {}),
  };
}

export function renderDispatchMarkdown(env: FullRunEnvelope, clientKind: ClientKind): string {
  const lines = [
    `**Dispatched** ${mdInlineCode(env.agent_id ?? 'agent')} as run \`${env.run_id}\`.`,
    '',
    `- Status: \`${env.status}\``,
    `- Worktree: ${mdInlineCode(env.worktree_path)}`,
  ];
  if (process.platform === 'darwin') {
    lines.push(
      `- **Tail in Terminal**: [open in a side window](${env.tail_url})`,
    );
  }
  lines.push(`- Tail manually: \`tail -F ${env.events_log_path}\``);
  if (env.required_next_action !== undefined) {
    if (clientKind === 'claude-code') {
      lines.push(
        `**REQUIRED before you end this turn:** spawn the watcher -> \`Bash(${env.required_next_action.command}, run_in_background: true)\`. Skip it and the run is orphaned.`,
      );
    } else if (clientKind === 'codex') {
      lines.push(
        `**REQUIRED before you end this turn:** start the Crew skill's deferred \`functions.exec\` watcher using \`required_next_action.command_json\` and yield control immediately. Command: ${mdInlineCode(env.required_next_action.command)}. Skip it and the run is orphaned.`,
      );
    }
  } else {
    lines.push(`- Next: ${nextStepSentence(clientKind, false)}`);
  }
  lines.push(`- Later status read: \`get_run_status({ run_id: "${env.run_id}" })\``);
  if (env.warnings && env.warnings.length > 0) {
    lines.push(
      '',
      '## Warnings',
      '',
      ...env.warnings.map((warning) => `- ${warning}`),
    );
  }
  return lines.join('\n');
}

export function requiredNextActionForRun(
  clientKind: ClientKind,
  crewWaitCommand: string | undefined,
  runId: string,
  crewHome: string,
  projectRoot: string,
): RequiredNextAction | undefined {
  if (
    (clientKind !== 'claude-code' && clientKind !== 'codex')
    || crewWaitCommand === undefined
  ) return undefined;
  const command = watcherCommand(clientKind, crewWaitCommand, [runId], crewHome);
  return {
    type: 'spawn_watcher',
    mechanism: clientKind === 'claude-code' ? 'background_shell' : 'deferred_code',
    command,
    command_json: JSON.stringify(command),
    run_ids_json: JSON.stringify([runId]),
    working_directory: projectRoot,
    working_directory_json: JSON.stringify(projectRoot),
    run_id: runId,
    run_in_background: true,
    per_run: true,
    consequence_if_skipped: clientKind === 'claude-code'
      ? 'Skip it and the run is orphaned; no watcher-triggered terminal turn will surface completion.'
      : 'Skip it and the run is orphaned; no deferred completion event will surface the terminal state.',
  };
}

export function requiredNextActionForRuns(
  clientKind: ClientKind,
  crewWaitCommand: string | undefined,
  runIds: readonly string[],
  crewHome: string,
  projectRoot: string,
): RequiredNextAction | undefined {
  if (
    (clientKind !== 'claude-code' && clientKind !== 'codex')
    || crewWaitCommand === undefined
    || runIds.length === 0
  ) return undefined;
  if (runIds.length === 1) {
    return requiredNextActionForRun(
      clientKind,
      crewWaitCommand,
      runIds[0],
      crewHome,
      projectRoot,
    );
  }
  const command = watcherCommand(clientKind, crewWaitCommand, runIds, crewHome);
  return {
    type: 'spawn_watcher',
    mechanism: clientKind === 'claude-code' ? 'background_shell' : 'deferred_code',
    command,
    command_json: JSON.stringify(command),
    run_ids_json: JSON.stringify(runIds),
    working_directory: projectRoot,
    working_directory_json: JSON.stringify(projectRoot),
    run_ids: [...runIds],
    run_in_background: true,
    per_run: false,
    consequence_if_skipped: clientKind === 'claude-code'
      ? 'Skip it and the panel is orphaned; no watcher-triggered terminal turn will surface panel completion.'
      : 'Skip it and the panel is orphaned; no deferred completion event will surface panel completion.',
  };
}

function watcherCommand(
  clientKind: Extract<ClientKind, 'claude-code' | 'codex'>,
  crewWaitCommand: string,
  runIds: readonly string[],
  crewHome: string,
): string {
  const crewHomeArg = ` --crew-home-base64 ${Buffer.from(crewHome, 'utf-8').toString('base64url')}`;
  return `${crewWaitCommand}${crewHomeArg} ${runIds.join(' ')}`;
}

export function mergeEnvelopeWarnings(
  ...warnings: Array<readonly string[] | undefined>
): { warnings?: readonly string[] } {
  const merged = warnings.flatMap((entry) => entry ?? []);
  return merged.length > 0 ? { warnings: merged } : {};
}

export function fileUrlHref(absPath: string): string {
  return pathToFileURL(absPath).href;
}

export function mdInlineCode(value: string): string {
  const normalized = value.replace(/[\r\n]+/g, ' ');
  if (!normalized.includes('`')) return `\`${normalized}\``;
  const longestBacktickRun = Math.max(
    ...Array.from(normalized.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(2, longestBacktickRun + 1));
  return `${fence} ${normalized} ${fence}`;
}

export function progressNotifierFrom(
  extra: ToolRequestExtra,
  agentId: string,
  seen: ProgressTokenSeen,
): ProgressNotifier | undefined {
  const token = extra._meta?.progressToken;
  const observed = token === undefined ? 'absent' : 'present';
  logger.info(
    `progress token (agent=${agentId}): ${
      token === undefined ? 'absent (no streaming chunks to captain)' : String(token)
    }`,
  );
  if (seen.lastObserved !== undefined && seen.lastObserved !== observed) {
    logger.info(
      `progressToken state changed from ${seen.lastObserved} to ${observed} this server session (agent=${agentId}).`,
    );
  }
  seen.lastObserved = observed;
  if (token === undefined && !seen.absentLogged) {
    seen.absentLogged = true;
    logger.warn(
      'progressToken absent on first dispatch without a token this server session ' +
      `(agent=${agentId}). Inline notifications/progress will not fire for this call. ` +
      'The dispatch markdown\'s tail.command / events.log side-channel and any ' +
      'later get_run_status / list_runs reads are the live progress paths. ' +
      'Known: codex CLI 0.128.0 omits the token; Claude Code supplies it.',
    );
  } else if (token !== undefined && !seen.presentLogged) {
    seen.presentLogged = true;
    logger.info(
      `progressToken present on first dispatch with a token this server session (agent=${agentId}); inline progress streaming active for this call.`,
    );
  }
  if (token === undefined) return undefined;
  let counter = 0;
  return {
    send(message: string): void {
      counter += 1;
      try {
        void extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken: token, progress: counter, message },
        })
          .catch(() => {
            // Swallow: progress notification failures must not fail dispatch.
          });
      } catch {
        // Swallow: progress notification failures must not fail dispatch.
      }
    },
  };
}

export function markdownContent<T extends object>(
  text: string,
  value: T,
  isError = false,
): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text }],
    structuredContent: value as unknown as Record<string, unknown>,
    isError,
  };
}

export function jsonContent<T extends object>(value: T, isError = false): ToolCallReturn {
  return markdownContent(JSON.stringify(value), value, isError);
}

export function renderMergeMarkdown(env: MergeEnvelope): string {
  if (env.status === 'merged') {
    const base = `**Merged** ${mdInlineCode(env.run_id)} → ${mdInlineCode(env.commit_sha ?? '')}`;
    if (env.restore_failed) {
      return `${base}\n\n${env.restore_warning ?? 'Merge landed, but checkout restore failed.'}`;
    }
    if (!env.landed_off_current_branch) return base;
    const original = env.original_branch
      ? mdInlineCode(env.original_branch)
      : `detached HEAD ${mdInlineCode(env.original_head ?? '')}`;
    return `${base}\n\nLanded on ${mdInlineCode(env.target_branch ?? '')}; restored ${original}.`;
  }
  if (env.status === 'conflict') {
    const conflicts = env.conflicts ?? [];
    return `**Conflict** on ${mdInlineCode(env.run_id)} (${conflicts.length} files): ${conflicts.join(', ')}`;
  }
  const base = `**No changes** to merge from ${mdInlineCode(env.run_id)}`;
  if (env.restore_failed) {
    return `${base}\n\n${env.restore_warning ?? 'No changes were merged, but checkout restore failed.'}`;
  }
  return base;
}

export function checkoutEnvelope(result: {
  readonly targetBranch: string;
  readonly originalBranch?: string;
  readonly originalHead: string;
  readonly landedOffCurrentBranch: boolean;
  readonly restoreFailed?: boolean;
  readonly restoreWarning?: string;
}): Pick<
  MergeEnvelope,
  | 'target_branch'
  | 'original_branch'
  | 'original_head'
  | 'landed_off_current_branch'
  | 'restore_failed'
  | 'restore_warning'
> {
  if (!result.landedOffCurrentBranch && !result.restoreFailed) return {};
  return {
    target_branch: result.targetBranch,
    ...(result.originalBranch ? { original_branch: result.originalBranch } : {}),
    original_head: result.originalHead,
    ...(result.landedOffCurrentBranch ? { landed_off_current_branch: true } : {}),
    ...(result.restoreFailed ? { restore_failed: true } : {}),
    ...(result.restoreWarning ? { restore_warning: result.restoreWarning } : {}),
  };
}

export function renderDiscardMarkdown(env: DiscardEnvelope): string {
  const base = `**Discarded** ${mdInlineCode(env.run_id)}`;
  if (!env.cleanup_failed || !env.cleanup_errors || env.cleanup_errors.length === 0) {
    return base;
  }
  return `${base}\n\nCleanup warning: ${env.cleanup_errors.join('; ')}`;
}

export function renderCancelMarkdown(env: {
  readonly run_id: string;
  readonly ok: boolean;
  readonly reason?: string;
}): string {
  if (env.ok) {
    return `**Cancelled** ${mdInlineCode(env.run_id)}`;
  }
  return `${mdInlineCode(env.run_id)} not cancelled: ${env.reason ?? 'unknown reason'}`;
}

export function getRunStatusContent<T extends object>(
  runId: string,
  payload: T,
): ToolCallReturn {
  return markdownContent(renderGetRunStatusMarkdown(runId, payload), payload);
}

export function renderGetRunStatusMarkdown(
  runId: string,
  payload: {
    readonly status?: unknown;
    readonly timed_out?: unknown;
    readonly next_event_line?: unknown;
    readonly filesChanged?: unknown;
    readonly summary?: unknown;
    readonly failure?: unknown;
    readonly events_tail_skipped?: unknown;
  },
): string {
  const status = typeof payload.status === 'string' ? payload.status : 'unknown';
  if (payload.timed_out === true) {
    const cursor = typeof payload.next_event_line === 'number'
      ? ` at cursor ${payload.next_event_line}`
      : '';
    return `${mdInlineCode(runId)} status: \`${status}\` (timed out${cursor})`;
  }

  if (!isTerminalRunStatus(status)) {
    const cursor = typeof payload.next_event_line === 'number'
      ? String(payload.next_event_line)
      : 'unknown';
    return `${mdInlineCode(runId)} status: \`${status}\` (cursor: ${cursor})`;
  }

  const lines = [`**${mdInlineCode(runId)} ${status}**`];
  const filesChanged = Array.isArray(payload.filesChanged)
    ? payload.filesChanged.filter((path): path is string => typeof path === 'string')
    : [];
  if (filesChanged.length > 0) {
    const firstPaths = filesChanged.slice(0, 3).join(', ');
    const more = filesChanged.length > 3
      ? ` [+ ${filesChanged.length - 3} more]`
      : '';
    lines.push(`${filesChanged.length} files changed: ${firstPaths}${more}`);
  }
  if (typeof payload.summary === 'string') {
    lines.push(`> ${truncateMarkdownSummary(payload.summary, 200)}`);
  }
  const failure = renderFailureSummary(payload.failure);
  if (failure) {
    lines.push(failure);
  }
  if (
    typeof payload.events_tail_skipped === 'number'
    && payload.events_tail_skipped > 0
  ) {
    lines.push(`${payload.events_tail_skipped} events skipped`);
  }
  return lines.join('\n');
}

function renderFailureSummary(failure: unknown): string | undefined {
  if (!failure || typeof failure !== 'object') return undefined;
  const record = failure as { kind?: unknown; recommendation?: unknown };
  if (typeof record.kind !== 'string' || !record.kind) return undefined;
  const recommendation = typeof record.recommendation === 'string' && record.recommendation
    ? ` (${record.recommendation})`
    : '';
  return `Failure: \`${record.kind}\`${recommendation}`;
}

function truncateMarkdownSummary(summary: string, maxChars: number): string {
  const normalized = summary.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

export function errorContent(message: string): ToolCallReturn {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isTerminalRunStatus(status: string): boolean {
  return (
    status === 'success'
    || status === 'partial'
    || status === 'error'
    || status === 'cancelled'
    || status === 'merged'
    || status === 'merge_conflict'
    || status === 'discarded'
  );
}

export function inFlightForRun(
  dispatcher: ToolDispatcher,
  runId: string,
): { toolCallId: string; toolName: string; runId?: string } | undefined {
  return dispatcher.listInFlight().find((entry) => entry.runId === runId);
}
