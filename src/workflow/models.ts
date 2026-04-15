export enum ModelId {
  CLAUDE_SONNET = 'claude-sonnet-4-6',
  CLAUDE_OPUS = 'claude-opus-4-6',
  GPT = 'gpt-5.4',
  GPT_CODEX = 'gpt-5.3-codex',
  GPT_MINI = 'gpt-5.4-mini',
  QWEN = 'qwen3:32b',
  QWEN_MINI = 'qwen3:14b',
}

export const CLAUDE_MODEL_PRESETS: readonly ModelId[] = [
  ModelId.CLAUDE_SONNET,
  ModelId.CLAUDE_OPUS,
];

export const CODEX_MODEL_PRESETS: readonly ModelId[] = [
  ModelId.GPT,
  ModelId.GPT_CODEX,
  ModelId.GPT_MINI,
];

export const OPENAI_COMPATIBLE_MODEL_PRESETS: readonly ModelId[] = [
  ModelId.QWEN,
  ModelId.QWEN_MINI,
];

export const ORCHESTRATOR_MODEL_PRESETS: readonly ModelId[] = [
  ModelId.CLAUDE_SONNET,
  ModelId.CLAUDE_OPUS,
  ModelId.GPT,
  ModelId.GPT_CODEX,
  ModelId.QWEN,
];
