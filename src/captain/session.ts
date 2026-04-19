// CaptainSession is the runtime face of a persisted captain conversation.
// It wraps SessionStore, providing:
//   - typed append helpers (user/assistant/tool_call/tool_result)
//   - an events() async iterable that streams what the session loop reacts to
//   - a providerSessionRef getter/setter that invalidates on schema/version drift
//
// The message log is the durable record of the conversation; providerSessionRef
// is a soft pointer into the adapter's native-resume path. Invalidating the
// ref (e.g. on a cliVersion bump) does NOT touch the message log — the session
// continues via full-replay on the next turn.

import type { SessionEvent } from './event-types.js';
import { SessionStore, type SessionSnapshot } from './session-store.js';
import type {
  SessionAssistantMessage,
  SessionMessage,
  SessionToolCallMessage,
  SessionToolResultMessage,
  SessionUserMessage,
} from '../state/types.js';
import type { ToolLoopMessage } from '../adapters/types.js';
import { logger } from '../utils/logger.js';

export interface CaptainSessionInit {
  projectRoot: string;
  cliVersionTag?: string;
  toolSchemaHash?: string;
}

export class CaptainSession {
  private readonly store: SessionStore;
  private readonly projectRoot: string;
  private messages: SessionMessage[] = [];
  private _providerSessionRef: string | undefined;
  private _cliVersionTag: string | undefined;
  private _toolSchemaHash: string | undefined;
  private startedAt: string;
  private lastTurnAt: string | undefined;
  private pendingEvents: Array<(event: SessionEvent) => void> = [];
  private liveEventListeners: Set<(event: SessionEvent) => void> = new Set();

  private constructor(init: {
    projectRoot: string;
    store: SessionStore;
    snapshot: SessionSnapshot | null;
    defaultCliVersionTag?: string;
    defaultToolSchemaHash?: string;
  }) {
    this.projectRoot = init.projectRoot;
    this.store = init.store;
    if (init.snapshot) {
      this.messages = init.snapshot.messages;
      this._providerSessionRef = init.snapshot.providerSessionRef;
      this._cliVersionTag = init.snapshot.cliVersionTag;
      this._toolSchemaHash = init.snapshot.toolSchemaHash;
      this.startedAt = init.snapshot.startedAt;
      this.lastTurnAt = init.snapshot.lastTurnAt;
    } else {
      this._cliVersionTag = init.defaultCliVersionTag;
      this._toolSchemaHash = init.defaultToolSchemaHash;
      this.startedAt = new Date().toISOString();
    }
  }

  static load(init: CaptainSessionInit): CaptainSession | null {
    const store = new SessionStore(init.projectRoot);
    const snapshot = store.loadSession();
    if (!snapshot) return null;
    return new CaptainSession({
      projectRoot: init.projectRoot,
      store,
      snapshot,
      defaultCliVersionTag: init.cliVersionTag,
      defaultToolSchemaHash: init.toolSchemaHash,
    });
  }

  static create(init: CaptainSessionInit): CaptainSession {
    const store = new SessionStore(init.projectRoot);
    return new CaptainSession({
      projectRoot: init.projectRoot,
      store,
      snapshot: null,
      defaultCliVersionTag: init.cliVersionTag,
      defaultToolSchemaHash: init.toolSchemaHash,
    });
  }

  static loadOrCreate(init: CaptainSessionInit): CaptainSession {
    return CaptainSession.load(init) ?? CaptainSession.create(init);
  }

  getMessages(): ReadonlyArray<SessionMessage> {
    return this.messages;
  }

  get providerSessionRef(): string | undefined {
    return this._providerSessionRef;
  }

  /**
   * Setting providerSessionRef may drop the stored value if the caller-supplied
   * invariants (cliVersionTag, toolSchemaHash) have drifted from the session's
   * cached values. Invalidation here is intentional: the message log survives,
   * but the native-resume shortcut is discarded.
   */
  set providerSessionRef(value: string | undefined) {
    this._providerSessionRef = value;
  }

  get cliVersionTag(): string | undefined {
    return this._cliVersionTag;
  }

  get toolSchemaHash(): string | undefined {
    return this._toolSchemaHash;
  }

  /**
   * Re-probe the CLI version and update the cached tag. Used as the one-turn
   * self-heal after an adapter reports a resume rejection: a prior turn's
   * cliVersionTag read may be stale (e.g., user upgraded the CLI between
   * turns), so we re-probe before the replay turn.
   *
   * getCliVersionTag() calls are expensive (Finding 12), so the session
   * caches the value and only re-probes on explicit request. If the fetched
   * value differs from the cached one, providerSessionRef is invalidated.
   *
   * Returns the fresh tag (or undefined if the adapter cannot determine it).
   */
  async refreshCliVersionTag(
    fetcher: () => Promise<string | undefined>,
  ): Promise<string | undefined> {
    let fresh: string | undefined;
    try {
      fresh = await fetcher();
    } catch (err: unknown) {
      logger.warn('[captain-session] refreshCliVersionTag: fetcher threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return this._cliVersionTag;
    }
    if (fresh === undefined) return this._cliVersionTag;
    this.updateEnvironmentFingerprint({ cliVersionTag: fresh });
    return fresh;
  }

  updateEnvironmentFingerprint(args: {
    cliVersionTag?: string;
    toolSchemaHash?: string;
  }): void {
    const cliChanged = args.cliVersionTag !== undefined && args.cliVersionTag !== this._cliVersionTag;
    const hashChanged = args.toolSchemaHash !== undefined && args.toolSchemaHash !== this._toolSchemaHash;

    if ((cliChanged || hashChanged) && this._providerSessionRef !== undefined) {
      logger.warn(
        '[captain-session] dropping providerSessionRef due to environment drift',
        {
          cliChanged,
          hashChanged,
          previousCli: this._cliVersionTag,
          nextCli: args.cliVersionTag,
          previousHash: this._toolSchemaHash,
          nextHash: args.toolSchemaHash,
        },
      );
      this._providerSessionRef = undefined;
    }

    if (args.cliVersionTag !== undefined) this._cliVersionTag = args.cliVersionTag;
    if (args.toolSchemaHash !== undefined) this._toolSchemaHash = args.toolSchemaHash;
  }

  appendMessage(message: SessionMessage): void {
    this.messages.push(message);
  }

  appendUserMessage(text: string, timestamp = new Date().toISOString()): SessionUserMessage {
    const message: SessionUserMessage = { role: 'user', text, timestamp };
    this.messages.push(message);
    this.emitEvent({ kind: 'user_message', text, ts: timestamp });
    return message;
  }

  appendAssistantMessage(text: string, timestamp = new Date().toISOString()): SessionAssistantMessage {
    const message: SessionAssistantMessage = { role: 'assistant', text, timestamp };
    this.messages.push(message);
    return message;
  }

  appendToolCall(call: {
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    timestamp?: string;
  }): SessionToolCallMessage {
    const message: SessionToolCallMessage = {
      role: 'tool_call',
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      timestamp: call.timestamp ?? new Date().toISOString(),
    };
    this.messages.push(message);
    return message;
  }

  appendToolResult(result: {
    toolCallId: string;
    output: unknown;
    status: SessionToolResultMessage['status'];
    timestamp?: string;
  }): SessionToolResultMessage {
    const ts = result.timestamp ?? new Date().toISOString();
    const message: SessionToolResultMessage = {
      role: 'tool_result',
      toolCallId: result.toolCallId,
      output: result.output,
      status: result.status,
      timestamp: ts,
    };
    this.messages.push(message);

    if (result.status === 'success') {
      this.emitEvent({
        kind: 'tool_completed',
        toolCallId: result.toolCallId,
        result: result.output,
        ts,
      });
    } else if (result.status === 'cancelled') {
      this.emitEvent({
        kind: 'tool_cancelled',
        toolCallId: result.toolCallId,
        reason: String(result.output ?? 'cancelled'),
        ts,
      });
    } else {
      this.emitEvent({
        kind: 'tool_failed',
        toolCallId: result.toolCallId,
        error: String(result.output ?? 'tool failed'),
        ts,
      });
    }

    return message;
  }

  /**
   * Push a raw event onto the log without producing a SessionMessage. Used by
   * consumers that want to emit cancellation/failure independent of the tool
   * result message (e.g., dispatcher timeouts where no message is produced).
   */
  appendEvent(event: SessionEvent): void {
    this.store.appendEvent(event);
    this.deliverToPending(event);
  }

  persist(): void {
    this.lastTurnAt = new Date().toISOString();
    this.store.writeSession(this.toSnapshot());
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  /**
   * Yields only NEW events emitted after subscription. Does not replay the
   * on-disk log — consumers that need the full history should read it via
   * getMessages() / toToolLoopMessages(), which are the durable record.
   *
   * This intentional asymmetry keeps the session loop from re-running a
   * turn for every disk-persisted event on cold start: the message log
   * already reflects them.
   */
  async *events(): AsyncIterable<SessionEvent> {
    while (true) {
      const next = await new Promise<SessionEvent>((resolve) => {
        this.pendingEvents.push(resolve);
      });
      yield next;
    }
  }

  /**
   * Subscribe to future events. Returns a Disposable. Used by the session
   * loop to drive turns from events without the overhead of async iteration.
   */
  subscribe(listener: (event: SessionEvent) => void): { dispose: () => void } {
    this.liveEventListeners.add(listener);
    return {
      dispose: () => {
        this.liveEventListeners.delete(listener);
      },
    };
  }

  /**
   * True when the session has material the captain has not yet responded to
   * (i.e., the last message is a user input or tool_result). Used by the
   * session loop to decide whether to kick off an initial turn on start.
   */
  hasPendingCaptainWork(): boolean {
    if (this.messages.length === 0) return false;
    const last = this.messages[this.messages.length - 1];
    return last.role === 'user' || last.role === 'tool_result';
  }

  /**
   * Convert the message log into the ToolLoopMessage shape an adapter turn
   * expects. Used when a providerSessionRef is invalid and the session must
   * replay full history to rebuild context.
   */
  toToolLoopMessages(): ToolLoopMessage[] {
    const out: ToolLoopMessage[] = [];
    for (const m of this.messages) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.text });
      } else if (m.role === 'tool_call') {
        out.push({
          role: 'assistant',
          content: `Tool call ${m.toolName}(${JSON.stringify(m.input)})`,
          name: m.toolName,
        });
      } else {
        out.push({
          role: 'tool',
          name: m.toolCallId,
          content: JSON.stringify({
            toolCallId: m.toolCallId,
            output: m.output,
            status: m.status,
          }),
        });
      }
    }
    return out;
  }

  private emitEvent(event: SessionEvent): void {
    this.store.appendEvent(event);
    this.deliverToPending(event);
  }

  private deliverToPending(event: SessionEvent): void {
    const resolvers = this.pendingEvents;
    this.pendingEvents = [];
    for (const resolver of resolvers) {
      resolver(event);
    }
    for (const listener of this.liveEventListeners) {
      try {
        listener(event);
      } catch {
        // Subscribers shouldn't break the session; swallow + continue.
      }
    }
  }

  private toSnapshot(): SessionSnapshot {
    return {
      schemaVersion: 1,
      messages: this.messages,
      providerSessionRef: this._providerSessionRef,
      cliVersionTag: this._cliVersionTag,
      toolSchemaHash: this._toolSchemaHash,
      startedAt: this.startedAt,
      lastTurnAt: this.lastTurnAt,
    };
  }
}
