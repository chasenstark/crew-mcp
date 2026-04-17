import { toAliasToken } from './alias-token.js';
import { AdapterId } from './agents.js';

export enum ModelId {
  CLAUDE_SONNET = 'claude-sonnet-4-7',
  CLAUDE_OPUS = 'claude-opus-4-7',
  GPT = 'gpt-5.4',
  GPT_CODEX = 'gpt-5.3-codex',
  GPT_MINI = 'gpt-5.4-mini',
  QWEN = 'qwen3:32b',
  QWEN_MINI = 'qwen3:14b',
}

const MODEL_ALIASES: Record<string, ModelId> = {
  CLAUDE_SONNET: ModelId.CLAUDE_SONNET,
  CLAUDE_OPUS: ModelId.CLAUDE_OPUS,
  GPT: ModelId.GPT,
  GPT_CODEX: ModelId.GPT_CODEX,
  GPT_MINI: ModelId.GPT_MINI,
  QWEN: ModelId.QWEN,
  QWEN_MINI: ModelId.QWEN_MINI,
};

export function resolveModelAlias(value: string): string {
  const trimmed = value.trim();
  const token = toAliasToken(trimmed);
  if (!token) return trimmed;
  return MODEL_ALIASES[token] ?? trimmed;
}

export function resolveModelAliasOrThrow(value: string, contextPath?: string): string {
  const trimmed = value.trim();
  const token = toAliasToken(trimmed);
  if (!token) return trimmed;

  const resolved = MODEL_ALIASES[token];
  if (resolved) return resolved;

  const location = contextPath ? ` for ${contextPath}` : '';
  const supported = Object.keys(MODEL_ALIASES).join(', ');
  throw new Error(`Unknown model alias "${token}"${location}. Supported aliases: ${supported}`);
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

export const CAPTAIN_MODEL_PRESETS: readonly ModelId[] = [
  ModelId.CLAUDE_SONNET,
  ModelId.CLAUDE_OPUS,
  ModelId.GPT,
  ModelId.GPT_CODEX,
  ModelId.QWEN,
];

export function modelPresetsForAdapter(adapterType?: string): readonly string[] {
  if (adapterType === AdapterId.CLAUDE_CODE) return CLAUDE_MODEL_PRESETS;
  if (adapterType === AdapterId.CODEX) return CODEX_MODEL_PRESETS;
  if (adapterType === AdapterId.OPENAI_COMPATIBLE) return OPENAI_COMPATIBLE_MODEL_PRESETS;
  return [];
}

export function isModelCompatibleWithAdapter(adapterType: string | undefined, model: string | undefined): boolean {
  const normalized = model?.trim();
  if (!normalized) return true;
  if (adapterType === AdapterId.CLAUDE_CODE) {
    return CLAUDE_MODEL_PRESETS.includes(normalized as ModelId);
  }
  if (adapterType === AdapterId.CODEX) {
    return CODEX_MODEL_PRESETS.includes(normalized as ModelId);
  }
  return true;
}
