import { logger } from '../../utils/logger.js';

export interface ResolvedCaps {
  body: number;
  excerpt: number;
  maxExcerpts: number;
  maxItems: number;
  aggregate: number;
  hardCeiling: number;
  composedPromptCap: number;
  overridesInvalid?: string[];
}

type CapKey = Exclude<keyof ResolvedCaps, 'overridesInvalid'>;
type CapOverrides = Partial<Record<CapKey, number>>;

export const DEFAULT_PEER_MESSAGE_CAPS: ResolvedCaps = {
  body: 16 * 1024,
  excerpt: 4 * 1024,
  maxExcerpts: 8,
  maxItems: 50,
  aggregate: 64 * 1024,
  hardCeiling: 128 * 1024,
  composedPromptCap: 256 * 1024,
};

const ENV_CAPS: Record<CapKey, string> = {
  body: 'CREW_PEER_MESSAGE_BODY_CAP_CHARS',
  excerpt: 'CREW_PEER_MESSAGE_EXCERPT_CAP_CHARS',
  maxExcerpts: 'CREW_PEER_MESSAGE_MAX_EXCERPTS',
  maxItems: 'CREW_PEER_MESSAGES_MAX_ITEMS',
  aggregate: 'CREW_PEER_MESSAGES_PREPEND_CAP_CHARS',
  hardCeiling: 'CREW_PEER_MESSAGES_HARD_CEILING',
  composedPromptCap: 'CREW_DISPATCH_PROMPT_CAP_CHARS',
};

export function resolvePeerMessageCaps(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedCaps {
  const overrides: CapOverrides = {};
  for (const [key, envName] of Object.entries(ENV_CAPS) as Array<[CapKey, string]>) {
    const raw = env[envName];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      overrides[key] = Math.floor(parsed);
    }
  }
  return validateCapRelationships(overrides);
}

export function validateCapRelationships(envCaps: Partial<ResolvedCaps>): ResolvedCaps {
  const overrides = stripOverridesInvalid(envCaps);
  const resolved: MutableCaps = { ...DEFAULT_PEER_MESSAGE_CAPS, ...overrides };
  const overridesInvalid: string[] = [];

  if (resolved.hardCeiling < resolved.aggregate) {
    if (overrides.hardCeiling !== undefined && overrides.aggregate === undefined) {
      overridesInvalid.push('hardCeiling');
      resolved.hardCeiling = DEFAULT_PEER_MESSAGE_CAPS.hardCeiling;
    } else if (overrides.aggregate !== undefined && overrides.hardCeiling === undefined) {
      overridesInvalid.push('aggregate');
      resolved.aggregate = DEFAULT_PEER_MESSAGE_CAPS.aggregate;
    } else {
      overridesInvalid.push('aggregate', 'hardCeiling');
      resolved.aggregate = DEFAULT_PEER_MESSAGE_CAPS.aggregate;
      resolved.hardCeiling = DEFAULT_PEER_MESSAGE_CAPS.hardCeiling;
    }
  }

  if (resolved.composedPromptCap < resolved.hardCeiling) {
    if (overrides.composedPromptCap !== undefined) {
      overridesInvalid.push('composedPromptCap');
      resolved.composedPromptCap = Math.max(
        DEFAULT_PEER_MESSAGE_CAPS.composedPromptCap,
        resolved.hardCeiling,
      );
    } else {
      resolved.composedPromptCap = resolved.hardCeiling;
    }
  }

  const worstCasePerItem = resolved.body + resolved.maxExcerpts * resolved.excerpt + 4 * 1024;
  if (resolved.aggregate < worstCasePerItem) {
    logger.warn(
      `peer_messages aggregate cap (${resolved.aggregate}) is smaller than ` +
      `worst-case per-item render (${worstCasePerItem}); first-message-force ` +
      'will frequently exceed aggregate.',
    );
  }

  return overridesInvalid.length > 0
    ? { ...resolved, overridesInvalid }
    : resolved;
}

type MutableCaps = {
  -readonly [K in CapKey]: number;
};

function stripOverridesInvalid(envCaps: Partial<ResolvedCaps>): CapOverrides {
  const out: CapOverrides = {};
  for (const key of Object.keys(ENV_CAPS) as CapKey[]) {
    const value = envCaps[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}
