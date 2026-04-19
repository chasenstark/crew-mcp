import chalk from 'chalk';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'process';
import type { CaptainSession } from '../../captain/session.js';
import type { ToolDispatcher } from '../../captain/tool-dispatcher.js';
import type { CrewRunner } from '../../captain/runner.js';

export type AskUserPolicy = 'fail' | 'prompt';

export function normalizeAskUserPolicy(raw: string | undefined, fallback: AskUserPolicy): AskUserPolicy {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'fail' || normalized === 'prompt') return normalized;
  throw new Error(`Invalid --on-ask-user policy "${raw}". Expected: fail or prompt.`);
}

/**
 * Headless ask_user handler (M1.5-11 rewrite).
 *
 * Subscribes to ToolDispatcher 'run:start' events. When an ask_user tool
 * call begins (the dispatched ask_user invocation from M1.5-5/6b), we:
 *
 *   - policy=fail: log the question, cancel the runner (mirrors pre-M1.5
 *     behavior for non-interactive CI / headless contexts).
 *   - policy=prompt: read a single line from stdin and append it as a
 *     user_message on the session. The coordinator in tools/ask-user.ts
 *     picks up the user_message and resolves the dispatched tool call.
 *
 * The pre-M1.5 runner.on('ask_user') + runner.provideUserInput() pair is
 * retired in this step.
 */
export function attachAskUserHandler(
  args: {
    runner: CrewRunner;
    session?: CaptainSession;
    dispatcher?: ToolDispatcher;
    policy: AskUserPolicy;
    failPrefix: string;
  },
): { dispose: () => void } {
  const { runner, session, dispatcher, policy, failPrefix } = args;
  if (!session || !dispatcher) {
    // Linear mode or older callers — ask_user never fires, so nothing to
    // attach. Return a no-op disposable.
    return { dispose: () => undefined };
  }

  const sub = dispatcher.onEvent('run:start', (info) => {
    if (info.toolName !== 'ask_user') return;
    void handleAskUser({
      toolCallId: info.toolCallId,
      session,
      runner,
      policy,
      failPrefix,
    });
  });
  return sub;
}

async function handleAskUser(args: {
  toolCallId: string;
  session: CaptainSession;
  runner: CrewRunner;
  policy: AskUserPolicy;
  failPrefix: string;
}): Promise<void> {
  const { toolCallId, session, runner, policy, failPrefix } = args;
  const question = findPendingAskUserQuestion(session, toolCallId) ?? 'Captain needs your input.';

  if (policy === 'fail') {
    const reason = `${failPrefix}: ${question}`;
    console.error(chalk.red(`\n  ${reason}`));
    runner.cancel(reason);
    return;
  }

  const rl = createInterface({ input, output });
  try {
    const response = await rl.question(`\n[captain] ${question}\n> `);
    // Append as a user_message; the coordinator in tools/ask-user.ts sees
    // the event and resolves the tool-call with this string.
    session.appendUserMessage(response);
  } finally {
    rl.close();
  }
}

function findPendingAskUserQuestion(session: CaptainSession, toolCallId: string): string | undefined {
  // The dispatched ask_user prepends a tool_call message on the session.
  // Walk backwards until we find it; return its `question` input.
  const messages = session.getMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'tool_call') continue;
    if (m.toolCallId !== toolCallId) continue;
    const q = (m.input as { question?: string }).question;
    return typeof q === 'string' ? q : undefined;
  }
  return undefined;
}
