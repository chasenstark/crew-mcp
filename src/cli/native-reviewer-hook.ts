import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';

import { recordNativeReviewerCompletion } from '../codex/native-reviewer-wake.js';
import { resolveGitRepoRoot } from '../install/repo-root.js';
import { resolveCrewHome } from '../utils/crew-home.js';

const MAX_HOOK_INPUT_BYTES = 64 * 1_024;

export interface NativeReviewerHookDeps {
  readonly crewHome?: string;
  readonly resolveRepoRoot?: typeof resolveGitRepoRoot;
  readonly recordCompletion?: typeof recordNativeReviewerCompletion;
}

export interface NativeReviewerHookOutcome {
  readonly handled: boolean;
  readonly action?: string;
  readonly reason?: string;
}

export async function processNativeReviewerHook(
  raw: string,
  deps: NativeReviewerHookDeps = {},
): Promise<NativeReviewerHookOutcome> {
  if (Buffer.byteLength(raw, 'utf-8') > MAX_HOOK_INPUT_BYTES) {
    return { handled: false, reason: 'hook input exceeded 64 KiB' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { handled: false, reason: 'hook input was not valid JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { handled: false, reason: 'hook input was not an object' };
  }
  const event = parsed as Record<string, unknown>;
  if (event.hook_event_name !== 'SubagentStop') {
    return { handled: false, reason: 'hook event was not SubagentStop' };
  }
  if (
    typeof event.session_id !== 'string'
    || typeof event.agent_id !== 'string'
    || typeof event.cwd !== 'string'
    || !isAbsolute(event.cwd)
  ) {
    return { handled: false, reason: 'SubagentStop identity or cwd was invalid' };
  }

  try {
    const repoRoot = await (deps.resolveRepoRoot ?? resolveGitRepoRoot)({ cwd: event.cwd });
    const result = await (deps.recordCompletion ?? recordNativeReviewerCompletion)({
      crewHome: deps.crewHome ?? resolveCrewHome(),
      repoRoot,
      threadId: event.session_id,
      agentId: event.agent_id,
    });
    return { handled: true, action: result.action };
  } catch (error) {
    return {
      handled: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function main(): Promise<number> {
  let outcome: NativeReviewerHookOutcome;
  try {
    outcome = await processNativeReviewerHook(await readStdin());
  } catch (error) {
    outcome = {
      handled: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!outcome.handled && outcome.reason) {
    process.stderr.write(`crew-native-reviewer-hook: ${bounded(outcome.reason)}\n`);
  }
  process.stdout.write(`${JSON.stringify({ continue: true, suppressOutput: true })}\n`);
  return 0;
}

function readStdin(): Promise<string> {
  return new Promise((resolveInput, reject) => {
    let input = '';
    let exceeded = false;
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk: string) => {
      if (exceeded) return;
      input += chunk;
      if (Buffer.byteLength(input, 'utf-8') > MAX_HOOK_INPUT_BYTES) {
        exceeded = true;
        reject(new Error('hook input exceeded 64 KiB'));
      }
    });
    process.stdin.on('end', () => {
      if (!exceeded) resolveInput(input);
    });
    process.stdin.on('error', reject);
  });
}

function bounded(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').slice(0, 500);
}

function isEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url))
      === realpathSync(resolve(process.argv[1]));
  } catch {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  }
}

if (isEntrypoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
