import { describe, expect, it } from 'vitest';

import { classifyTextFailure } from '../../src/adapters/failure-classifier.js';

describe('classifyTextFailure', () => {
  it('does not treat bare exceeded text as a quota or rate-limit signal', () => {
    for (const signal of ['context length exceeded', 'rpc error: code = DeadlineExceeded desc = deadline exceeded']) {
      const failure = classifyTextFailure(signal);
      expect(failure).toMatchObject({
        kind: 'unknown',
        confidence: 'low',
      });
      expect(failure.kind).not.toBe('quota_exhausted');
      expect(failure.kind).not.toBe('rate_limited');
    }
  });

  it('keeps quota and rate-limit exceeded signals classified', () => {
    expect(classifyTextFailure('quota exceeded')).toMatchObject({
      kind: 'quota_exhausted',
      confidence: 'low',
      recommendation: 'reroute',
    });
    expect(classifyTextFailure('rate limit exceeded')).toMatchObject({
      kind: 'rate_limited',
      confidence: 'low',
      recommendation: 'backoff',
    });
    expect(classifyTextFailure('RESOURCE_EXHAUSTED')).toMatchObject({
      kind: 'quota_exhausted',
      confidence: 'low',
      recommendation: 'reroute',
    });
  });

  it('does not treat arbitrary 5xx-looking durations as transient', () => {
    const failure = classifyTextFailure('request completed in 562 ms');
    expect(failure).toMatchObject({
      kind: 'unknown',
      confidence: 'low',
    });
    expect(failure.kind).not.toBe('transient');
  });

  it('keeps HTTP-framed 5xx statuses transient', () => {
    expect(classifyTextFailure('HTTP 503 from provider')).toMatchObject({
      kind: 'transient',
      confidence: 'low',
      recommendation: 'backoff',
    });
    expect(classifyTextFailure('response status: 500')).toMatchObject({
      kind: 'transient',
      confidence: 'low',
      recommendation: 'backoff',
    });
  });
});
