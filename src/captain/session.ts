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

interface EventSubscription {
  queue: SessionEvent[];
  waiting: ((event: SessionEvent) => void) | null;
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
  // Per-iterator subscription. Each active events() iterator owns a queue +
  // a single 'waiting' resolver slot. When an event arrives, we resolve the
  // waiting slot if present; otherwise we push the event into the queue so a
  // subsequent next() can drain it. This prevents the B4 drop-window bug
  // where two events fired between await-points would orphan the second one.
  private eventSubscriptions = new Set<EventSubscription>();
  private liveEventListeners: Set<(event: SessionEvent) => void> = new Set();
  // Cache for messagesSinceToolCall — invalidated on every append so the
  // advisory computation runs O(1) on steady-state and O(n) once per-append.
  // Per-toolName; keys clear wholesale on mutation rather than selectively
  // because a new tool_call message could be the target tool.
  private sinceToolCallCache = new Map<string, number>();

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
      this._activePreset = init.snapshot.activePreset;
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

  private _activePreset: string | undefined;

  /**
   * M5-4: the session's currently-active preset override (set via
   * `/preset <name>`). When non-empty, beats `config.captain.preset` at
   * per-turn resolution. Storing just the NAME (not the resolved config)
   * means a hint edit in workflow.yaml between turns takes effect without
   * a session-side migration — the resolver reads the live presets map each
   * turn.
   */
  get activePreset(): string | undefined {
    return this._activePreset;
  }

  /**
   * Set (or clear, when passed `undefined`) the session's active preset.
   *
   * **Atomicity contract:** the in-memory mutation, the snapshot persist,
   * and the `preset_changed` event either ALL land or NONE does. If
   * persist throws (disk full, permission denied, lock contention), the
   * in-memory mutation is rolled back before re-throwing — the caller
   * sees the error, the event log stays clean, and the next load sees
   * the pre-swap value. This gives `/preset` the "either the switch
   * happened or it didn't" guarantee that the slash-command handler
   * relies on.
   *
   * Does NOT bump `lastTurnAt` — that field reflects turn-boundary
   * timestamps, not preset-swap timestamps. Conflating them would make
   * debugging "did preset swap land before or after turn N" harder.
   *
   * Preset swaps are NOT tool-schema material — providerSessionRef is
   * intentionally preserved (a mid-run preset switch should not invalidate
   * native-resume). See `docs/architecture/presets.md` for the invariant.
   */
  setActivePreset(name: string | undefined): void {
    const normalized = typeof name === 'string' && name.length > 0 ? name : undefined;
    if (normalized === this._activePreset) {
      // No-op: avoids churning the event log on redundant calls.
      return;
    }
    const previous = this._activePreset;
    this._activePreset = normalized;
    try {
      // Persist without touching `lastTurnAt` — a preset swap isn't a turn.
      this.store.writeSession(this.toSnapshot());
    } catch (err) {
      // Rollback the in-memory mutation so the session + the (unwritten)
      // snapshot agree. Then re-throw so the /preset handler surfaces the
      // error instead of silently accepting a half-committed swap.
      this._activePreset = previous;
      throw err;
    }
    // Only log the event once persist succeeded — an event in the log
    // without a corresponding snapshot update would mislead future
    // debuggers reading events.log.
    this.store.appendEvent({
      kind: 'preset_changed',
      preset: normalized,
      ts: new Date().toISOString(),
    });
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
    this.sinceToolCallCache.clear();
  }

  appendUserMessage(text: string, timestamp = new Date().toISOString()): SessionUserMessage {
    const message: SessionUserMessage = { role: 'user', text, timestamp };
    this.messages.push(message);
    this.sinceToolCallCache.clear();
    this.emitEvent({ kind: 'user_message', text, ts: timestamp });
    return message;
  }

  appendAssistantMessage(text: string, timestamp = new Date().toISOString()): SessionAssistantMessage {
    const message: SessionAssistantMessage = { role: 'assistant', text, timestamp };
    this.messages.push(message);
    this.sinceToolCallCache.clear();
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
    this.sinceToolCallCache.clear();
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
    this.sinceToolCallCache.clear();

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
   * Yields only NEW events emitted after subscription — events appended
   * BEFORE the iterator starts are NOT replayed. Callers that need full
   * history should read it via getMessages() / toToolLoopMessages(),
   * which are the durable record.
   *
   * This intentional asymmetry keeps the session loop from re-running a
   * turn for every disk-persisted event on cold start: the message log
   * already reflects them.
   *
   * Per-iterator buffering: each active iterator has its own queue + waiting
   * slot. Events fired while the consumer is between next() calls are queued
   * rather than dropped (the B4 drop-window fix).
   */
  async *events(): AsyncIterable<SessionEvent> {
    const sub: EventSubscription = { queue: [], waiting: null };
    this.eventSubscriptions.add(sub);
    try {
      while (true) {
        if (sub.queue.length > 0) {
          yield sub.queue.shift() as SessionEvent;
          continue;
        }
        const next = await new Promise<SessionEvent>((resolve) => {
          sub.waiting = resolve;
        });
        yield next;
      }
    } finally {
      this.eventSubscriptions.delete(sub);
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
   * Distance (in message-log entries) since the most recent `tool_call`
   * message for `toolName`. Returns `Number.MAX_SAFE_INTEGER` when the tool
   * has never been called — an unambiguous "far in the past" sentinel that
   * threshold comparisons (`distance >= 15`) treat as always-true.
   *
   * Scan-on-demand (no persisted index): backward scan once per call, cached
   * until the next append. The cache is invalidated wholesale on any append
   * since a fresh `tool_call` for the target tool would flip the result.
   * This keeps `session.json` schema stable across M4 — the advisory is
   * purely a runtime consideration (Finding: M4-2 persistence).
   */
  messagesSinceToolCall(toolName: string): number {
    const cached = this.sinceToolCallCache.get(toolName);
    if (cached !== undefined) return cached;
    let distance = Number.MAX_SAFE_INTEGER;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'tool_call' && m.toolName === toolName) {
        distance = this.messages.length - 1 - i;
        break;
      }
    }
    this.sinceToolCallCache.set(toolName, distance);
    return distance;
  }

  /**
   * Approximate serialized size of the in-memory message log, in bytes. Uses
   * JSON.stringify of each message as a proxy for the persisted session.json
   * size. Callers (M4-2 compression advisory) use this as an upper-bound
   * cheap proxy; not suitable for tight budgeting.
   */
  approximateMessageLogBytes(): number {
    let total = 0;
    for (const m of this.messages) {
      total += JSON.stringify(m).length;
    }
    return total;
  }

  /**
   * Convert the message log into the ToolLoopMessage shape an adapter turn
   * expects. Used when a providerSessionRef is invalid and the session must
   * replay full history to rebuild context.
   *
   * N2 caveat (M3-scope): tool_call messages are serialized as prose
   * (`Tool call foo({...})`) because ToolLoopMessage doesn't yet have a
   * structured tool_call variant. Adapters that want the real structured
   * tool-call form (e.g., OpenAI's `tool_calls`) won't get it on replay.
   * The session log is still correct; the serialization is what gets
   * lossy. Fix alongside the M3 adapter-contract rework.
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
    for (const sub of this.eventSubscriptions) {
      if (sub.waiting) {
        const resolve = sub.waiting;
        sub.waiting = null;
        resolve(event);
      } else {
        sub.queue.push(event);
      }
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
      schemaVersion: 2,
      messages: this.messages,
      providerSessionRef: this._providerSessionRef,
      cliVersionTag: this._cliVersionTag,
      toolSchemaHash: this._toolSchemaHash,
      startedAt: this.startedAt,
      lastTurnAt: this.lastTurnAt,
      activePreset: this._activePreset,
    };
  }
}
