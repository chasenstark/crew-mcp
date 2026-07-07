export enum AgentId {
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex',
  AGY = 'agy',
}

export enum AdapterId {
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex',
  AGY = 'agy',
  GENERIC = 'generic',
  OPENAI_COMPATIBLE = 'openai-compatible',
}

export const BUILTIN_WORKER_AGENTS: readonly AgentId[] = [
  AgentId.CLAUDE_CODE,
  AgentId.CODEX,
  AgentId.AGY,
];
