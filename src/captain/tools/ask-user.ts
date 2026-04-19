// ask_user is modeled as a tool rather than a slot-based pause. The captain
// calls dispatchAskUser() which:
//
//   1. appends a `tool_call` message to the session (durable record)
//   2. starts a dispatch task whose run() awaits the next `user_message`
//      event on the session — keyed per toolCallId, so concurrent ask_user
//      calls resolve independently
//   3. when the user_message arrives (from App.tsx, attachAskUserHandler,
//      or any other UI input source), the promise resolves and the helper
//      appends a `tool_result` to the session
//   4. if the dispatcher is cancelled mid-wait, the helper appends a
//      cancelled tool_result and rethrows the abort
//
// Concurrent semantics: each dispatchAskUser has a unique toolCallId and
// waits for its OWN next user_message event. With two concurrent ask_user
// calls in flight, the first user_message resolves BOTH (FIFO across
// toolCallIds is not meaningful; the plan explicitly says resolution is
// per-toolCallId, so a single user message answers whichever request is
// at the front of the FIFO, and a second message answers the other).

import { randomUUID } from 'crypto';
import type { CaptainSession } from '../session.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';

export interface DispatchAskUserArgs {
  session: CaptainSession;
  dispatcher: ToolDispatcher;
  question: string;
  toolCallId?: string;
  /**
   * If provided, this signal aborts the wait for a user message. Completion
   * still writes a cancelled tool_result. Used by the session-loop terminator.
   */
  externalSignal?: AbortSignal;
}

export interface AskUserResult {
  toolCallId: string;
  response: string;
}

/**
 * Coordinate ask_user calls so a new dispatchAskUser always waits for the
 * NEXT user_message event (not one that slipped in before it subscribed).
 *
 * Ordering model: the coordinator maintains a FIFO queue of `accept`
 * callbacks. Each `subscribe()` appends one closure; each user_message
 * event pops the oldest and resolves it with the message text. The
 * FIFO happens to match subscription order — which is the order
 * dispatchAskUser calls `coordinatorFor(session).subscribe(signal)`.
 * It is NOT per-toolCallId keyed: the coordinator doesn't know about
 * toolCallIds at all. Concurrent dispatchAskUser calls each register
 * their own subscriber, and user messages resolve them in the order
 * they subscribed (not in the order their toolCallIds were assigned).
 *
 * Aborting a subscriber via the provided signal removes it from the
 * queue, so a dead subscriber never steals a later user message.
 */
class AskUserCoordinator {
  private subscribers: Array<(text: string) => void> = [];
  private started = false;

  constructor(private readonly session: CaptainSession) {}

  async subscribe(signal: AbortSignal): Promise<string> {
    this.ensureStarted();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      const accept = (text: string) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abortListener);
        resolve(text);
      };
      const abortListener = () => {
        if (settled) return;
        settled = true;
        // Remove this subscriber from the queue so a user_message doesn't
        // resolve a dead one.
        this.subscribers = this.subscribers.filter((s) => s !== accept);
        reject(new AskUserAbortError(signal.reason));
      };
      signal.addEventListener('abort', abortListener);
      this.subscribers.push(accept);
    });
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    void this.consume();
  }

  private async consume(): Promise<void> {
    for await (const event of this.session.events()) {
      if (event.kind !== 'user_message') continue;
      const next = this.subscribers.shift();
      if (!next) continue;
      next(event.text);
    }
  }
}

const coordinators = new WeakMap<CaptainSession, AskUserCoordinator>();

function coordinatorFor(session: CaptainSession): AskUserCoordinator {
  let c = coordinators.get(session);
  if (!c) {
    c = new AskUserCoordinator(session);
    coordinators.set(session, c);
  }
  return c;
}

/**
 * Block until the NEXT user_message event on the session, or reject if the
 * signal aborts. Used by the judgment-runner scheduler for ask_user without
 * double-wrapping a second dispatcher task on top of the one the scheduler
 * already returned. Callers that want both (a) session tool_call appending
 * and (b) dispatcher scheduling should use dispatchAskUser.
 */
export async function waitForUserResponse(
  session: CaptainSession,
  signal: AbortSignal,
): Promise<string> {
  return coordinatorFor(session).subscribe(signal);
}

export async function dispatchAskUser(args: DispatchAskUserArgs): Promise<AskUserResult> {
  const toolCallId = args.toolCallId ?? randomUUID();
  args.session.appendToolCall({
    toolCallId,
    toolName: 'ask_user',
    input: { question: args.question },
  });

  // NOTE: this helper does NOT append a tool_result to the session. The
  // dispatcher's terminal events (run:complete/failed/cancelled) are the
  // authority for tool_result writes; SessionLoop.wireDispatcherEvents
  // already handles that path. Writing here too would produce duplicate
  // tool_result messages under production (B2 in the M1.5 review).
  //
  // In tests or ad-hoc callers that use dispatchAskUser without a
  // SessionLoop around it, the tool_result simply won't be written to the
  // session — which is correct: a dispatcher without a subscriber has no
  // durable side effect beyond the promise resolution below.

  // Propagate externalSignal aborts through the dispatcher so the dispatcher
  // emits run:cancelled (not run:failed) when the external signal fires.
  let externalAbortHandler: (() => void) | null = null;
  if (args.externalSignal) {
    const dispatcher = args.dispatcher;
    if (args.externalSignal.aborted) {
      // Pre-aborted — cancel the dispatcher call once it's registered.
      setImmediate(() => {
        dispatcher.cancel(toolCallId, readAbortReason(args.externalSignal?.reason));
      });
    } else {
      externalAbortHandler = () => {
        dispatcher.cancel(toolCallId, readAbortReason(args.externalSignal?.reason));
      };
      args.externalSignal.addEventListener('abort', externalAbortHandler, { once: true });
    }
  }

  return new Promise<AskUserResult>((resolve, reject) => {
    args.dispatcher.start({
      toolCallId,
      toolName: 'ask_user',
      input: { question: args.question },
      run: async (ctx) => {
        try {
          const response = await coordinatorFor(args.session).subscribe(ctx.signal);
          resolve({ toolCallId, response });
          return response;
        } catch (err: unknown) {
          if (err instanceof AskUserAbortError) {
            reject(err);
          } else {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
          throw err;
        } finally {
          if (externalAbortHandler && args.externalSignal) {
            args.externalSignal.removeEventListener('abort', externalAbortHandler);
          }
        }
      },
    });
  });
}

function readAbortReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  return 'cancelled';
}

class AskUserAbortError extends Error {
  readonly name = 'AskUserAbortError';
  constructor(reason: unknown) {
    super(typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : 'cancelled');
  }
}

export { AskUserAbortError };
