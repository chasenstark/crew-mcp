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

export type SessionEvent =
  | UserMessageEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | ToolCancelledEvent;

export type SessionEventKind = SessionEvent['kind'];
