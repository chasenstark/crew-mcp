import type { TaskFailure } from './types.js';

type FailureKind = TaskFailure['kind'];
type FailureConfidence = TaskFailure['confidence'];

export function recommendationForFailureKind(
  kind: FailureKind,
): TaskFailure['recommendation'] | undefined {
  switch (kind) {
    case 'rate_limited':
    case 'transient':
      return 'backoff';
    case 'quota_exhausted':
      return 'reroute';
    case 'auth':
      return 'ask_user';
    case 'process':
    case 'unknown':
      return undefined;
  }
}

export function buildTaskFailure(args: {
  readonly kind: FailureKind;
  readonly confidence: FailureConfidence;
  readonly providerCode?: string;
  readonly retryAfterSeconds?: number;
  readonly resetAt?: string;
  readonly rawSignal?: string;
  readonly recommendation?: TaskFailure['recommendation'];
}): TaskFailure {
  const recommendation = args.recommendation ?? recommendationForFailureKind(args.kind);
  return {
    kind: args.kind,
    confidence: args.confidence,
    ...(args.providerCode ? { providerCode: args.providerCode } : {}),
    ...(args.retryAfterSeconds !== undefined ? { retryAfterSeconds: args.retryAfterSeconds } : {}),
    ...(args.resetAt ? { resetAt: args.resetAt } : {}),
    ...(args.rawSignal ? { rawSignal: args.rawSignal } : {}),
    ...(recommendation ? { recommendation } : {}),
  };
}

export function classifyHttpFailure(args: {
  readonly status: number;
  readonly body?: string;
  readonly providerCode?: string;
  readonly retryAfterSeconds?: number;
  readonly resetAt?: string;
}): TaskFailure {
  const rawSignal = compactSignal(args.body ?? `HTTP ${args.status}`);
  const providerCode = args.providerCode ?? String(args.status);
  if (args.status === 401 || args.status === 403) {
    return buildTaskFailure({
      kind: 'auth',
      confidence: 'high',
      providerCode,
      rawSignal,
      retryAfterSeconds: args.retryAfterSeconds,
      resetAt: args.resetAt,
    });
  }
  if (args.status === 429) {
    return buildTaskFailure({
      kind: limitFailureKind(args.body ?? ''),
      confidence: 'high',
      providerCode,
      rawSignal,
      retryAfterSeconds: args.retryAfterSeconds,
      resetAt: args.resetAt,
    });
  }
  if (args.status >= 500 && args.status <= 599) {
    return buildTaskFailure({
      kind: 'transient',
      confidence: 'high',
      providerCode,
      rawSignal,
      retryAfterSeconds: args.retryAfterSeconds,
      resetAt: args.resetAt,
    });
  }
  return buildTaskFailure({
    kind: 'unknown',
    confidence: 'high',
    providerCode,
    rawSignal,
  });
}

export function classifyTextFailure(
  signal: string | undefined,
  options: {
    readonly defaultKind?: FailureKind;
    readonly providerCode?: string;
    readonly confidence?: FailureConfidence;
  } = {},
): TaskFailure {
  const text = signal ?? '';
  const confidence = options.providerCode ? 'high' : options.confidence ?? 'low';
  const rawSignal = compactSignal(text);
  const providerCode = options.providerCode;
  if (isIneligibleTierSignal(text)) {
    const codedIneligibleTier = /\bIneligibleTierError\b/i.test(text);
    return buildTaskFailure({
      kind: 'auth',
      confidence: providerCode || codedIneligibleTier ? 'high' : confidence,
      providerCode: providerCode ?? 'IneligibleTierError',
      rawSignal,
    });
  }
  if (isAuthSignal(text)) {
    return buildTaskFailure({
      kind: 'auth',
      confidence,
      ...(providerCode ? { providerCode } : {}),
      rawSignal,
    });
  }
  if (isTransientSignal(text)) {
    return buildTaskFailure({
      kind: 'transient',
      confidence,
      ...(providerCode ? { providerCode } : {}),
      rawSignal,
    });
  }
  if (isRateLimitSignal(text)) {
    return buildTaskFailure({
      kind: limitFailureKind(text),
      confidence,
      ...(providerCode ? { providerCode } : {}),
      rawSignal,
    });
  }
  return buildTaskFailure({
    kind: options.defaultKind ?? 'unknown',
    confidence,
    ...(providerCode ? { providerCode } : {}),
    rawSignal,
  });
}

export function isIneligibleTierSignal(text: string): boolean {
  return /\bIneligibleTierError\b/i.test(text)
    || (/no longer supported/i.test(text) && /Antigravity/i.test(text));
}

function isAuthSignal(text: string): boolean {
  return /\b(401|403)\b/.test(text)
    || /\b(auth(?:entication|orization)? failed|unauthorized|forbidden|permission denied|invalid api key|api key)\b/i.test(text);
}

function isTransientSignal(text: string): boolean {
  return hasHttp5xxStatus(text)
    || /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN)\b/i.test(text)
    || /\b(timeout|timed out|temporarily unavailable|service unavailable|network error)\b/i.test(text);
}

function isRateLimitSignal(text: string): boolean {
  return /\b429\b/.test(text)
    || /\b(rate[\s_-]?limit|usage[\s_-]?limit|quota|insufficient_quota|RESOURCE_EXHAUSTED)\b/i.test(text)
    || hasExceededLimitContext(text);
}

function hasQuotaExhaustionToken(text: string): boolean {
  return /\b(insufficient_quota|usage[\s_-]?limit|quota|RESOURCE_EXHAUSTED|exhausted)\b/i.test(text)
    || hasExceededQuotaContext(text);
}

function limitFailureKind(text: string): Extract<FailureKind, 'quota_exhausted' | 'rate_limited'> {
  if (
    /\brate[\s_-]?limit\b/i.test(text)
    && !/\b(insufficient_quota|usage[\s_-]?limit|quota|RESOURCE_EXHAUSTED|exhausted)\b/i.test(text)
  ) {
    return 'rate_limited';
  }
  return hasQuotaExhaustionToken(text) ? 'quota_exhausted' : 'rate_limited';
}

function compactSignal(text: string): string | undefined {
  const compacted = text.replace(/\s+/g, ' ').trim();
  if (!compacted) return undefined;
  return compacted.length <= 240 ? compacted : `${compacted.slice(0, 239).trimEnd()}...`;
}

function hasExceededLimitContext(text: string): boolean {
  return /\b(?:quota|resources?|resource[\s_-]?limit|usage[\s_-]?limit|rate[\s_-]?limit|limit)[\s_-]+exceeded\b/i.test(text)
    || /\bexceeded[\s_-]+(?:quota|resources?|resource[\s_-]?limit|usage[\s_-]?limit|rate[\s_-]?limit|limit)\b/i.test(text);
}

function hasExceededQuotaContext(text: string): boolean {
  return /\b(?:quota|resources?|resource[\s_-]?limit|usage[\s_-]?limit)[\s_-]+exceeded\b/i.test(text)
    || /\bexceeded[\s_-]+(?:quota|resources?|resource[\s_-]?limit|usage[\s_-]?limit)\b/i.test(text);
}

function hasHttp5xxStatus(text: string): boolean {
  return /\b(?:http(?:\/\d(?:\.\d)?)?|http[\s_-]?status|status(?:[\s_-]?code)?|response[\s_-]?status|server[\s_-]+returned|returned[\s_-]+status)[\s:=#-]*5\d\d\b/i.test(text)
    || /\b5\d\d[\s_-]+(?:http[\s_-]?status|status(?:[\s_-]?code)?|response[\s_-]?status)\b/i.test(text);
}
