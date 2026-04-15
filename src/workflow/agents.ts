export enum AgentId {
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex',
  GEMINI_CLI = 'gemini-cli',
  ORCHESTRATOR = 'orchestrator',
}

export enum AdapterId {
  CLAUDE_CODE = 'claude-code',
  CODEX = 'codex',
  GEMINI_CLI = 'gemini-cli',
  GENERIC = 'generic',
  OPENAI_COMPATIBLE = 'openai-compatible',
}

export const BUILTIN_WORKER_AGENTS: readonly AgentId[] = [
  AgentId.CLAUDE_CODE,
  AgentId.CODEX,
  AgentId.GEMINI_CLI,
];

export const ADAPTER_PRESETS: readonly AdapterId[] = [
  AdapterId.CLAUDE_CODE,
  AdapterId.CODEX,
  AdapterId.GEMINI_CLI,
  AdapterId.GENERIC,
  AdapterId.OPENAI_COMPATIBLE,
];

const AGENT_ALIASES: Record<string, AgentId> = {
  CLAUDE_CODE: AgentId.CLAUDE_CODE,
  CODEX: AgentId.CODEX,
  GEMINI_CLI: AgentId.GEMINI_CLI,
  ORCHESTRATOR: AgentId.ORCHESTRATOR,
};

const ADAPTER_ALIASES: Record<string, AdapterId> = {
  CLAUDE_CODE: AdapterId.CLAUDE_CODE,
  CODEX: AdapterId.CODEX,
  GEMINI_CLI: AdapterId.GEMINI_CLI,
  GENERIC: AdapterId.GENERIC,
  OPENAI_COMPATIBLE: AdapterId.OPENAI_COMPATIBLE,
};

function toAliasToken(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const wrapped = /^\$\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(trimmed);
  if (wrapped) return wrapped[1].toUpperCase();

  if (/^[A-Z][A-Z0-9_]*$/.test(trimmed)) return trimmed.toUpperCase();
  return null;
}

export function resolveAgentAlias(value: string): string {
  const trimmed = value.trim();
  const token = toAliasToken(trimmed);
  if (!token) return trimmed;
  return AGENT_ALIASES[token] ?? trimmed;
}

export function resolveAdapterAlias(value: string): string {
  const trimmed = value.trim();
  const token = toAliasToken(trimmed);
  if (!token) return trimmed;
  return ADAPTER_ALIASES[token] ?? trimmed;
}

export function resolveAdapterAliasOrThrow(value: string, contextPath?: string): string {
  const trimmed = value.trim();
  const token = toAliasToken(trimmed);
  if (!token) return trimmed;

  const resolved = ADAPTER_ALIASES[token];
  if (resolved) return resolved;

  const location = contextPath ? ` for ${contextPath}` : '';
  const supported = Object.keys(ADAPTER_ALIASES).join(', ');
  throw new Error(`Unknown adapter alias "${token}"${location}. Supported aliases: ${supported}`);
}
