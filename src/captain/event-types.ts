// SessionEvent is the wire-format of activity between the user, the captain,
// and tool executions. A SessionStore is the durable append-only log of these;
// a CaptainSession reads from it to drive the event loop.
//
// Events are narrower than SessionMessages: a SessionMessage is what the
// captain adapter sees in its conversation history; a SessionEvent is what the
// session loop reacts to. A single tool_completed event may in turn produce a
// `tool_result` SessionMessage that gets threaded into the next captain turn.

export interface UserMessageEvent {
  kind: 'user_message';
  text: string;
  ts: string;
}

export interface ToolCompletedEvent {
  kind: 'tool_completed';
  toolCallId: string;
  result: unknown;
  ts: string;
}

export interface ToolFailedEvent {
  kind: 'tool_failed';
  toolCallId: string;
  error: string;
  ts: string;
}

export interface ToolCancelledEvent {
  kind: 'tool_cancelled';
  toolCallId: string;
  reason: string;
  ts: string;
}

/**
 * M5-4: emitted when the session's active preset changes via
 * `setActivePreset()` (driven by `/preset <name>` or `/preset clear`).
 * Observability-only — the session-loop does NOT react to this event;
 * per-turn preset resolution reads the session's current `activePreset`
 * directly at turn start. The event log lets a human debugger see when
 * the switch happened and what the captain's system prompt reflected
 * from that point on.
 */
export interface PresetChangedEvent {
  kind: 'preset_changed';
  preset: string | undefined;
  ts: string;
}

export type SessionEvent =
  | UserMessageEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolCancelledEvent
  | PresetChangedEvent;

export type SessionEventKind = SessionEvent['kind'];
