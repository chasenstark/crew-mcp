import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PEER_MESSAGE_CAPS,
  resolvePeerMessageCaps,
  validateCapRelationships,
} from '../../../src/orchestrator/peer-messages/caps.js';
import { logger } from '../../../src/utils/logger.js';

describe('validateCapRelationships', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('resets a lowered hardCeiling that falls below aggregate', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      body: 123,
      hardCeiling: DEFAULT_PEER_MESSAGE_CAPS.aggregate - 1,
    });

    expect(resolved.body).toBe(123);
    expect(resolved.hardCeiling).toBe(DEFAULT_PEER_MESSAGE_CAPS.hardCeiling);
    expect(resolved.overridesInvalid).toEqual(['hardCeiling']);
  });

  it('resets a raised aggregate that exceeds hardCeiling', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      aggregate: DEFAULT_PEER_MESSAGE_CAPS.hardCeiling + 1,
    });

    expect(resolved.aggregate).toBe(DEFAULT_PEER_MESSAGE_CAPS.aggregate);
    expect(resolved.overridesInvalid).toEqual(['aggregate']);
  });

  it('resets both aggregate and hardCeiling when both are overridden invalidly', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      aggregate: 200 * 1024,
      hardCeiling: 100 * 1024,
    });

    expect(resolved.aggregate).toBe(DEFAULT_PEER_MESSAGE_CAPS.aggregate);
    expect(resolved.hardCeiling).toBe(DEFAULT_PEER_MESSAGE_CAPS.hardCeiling);
    expect(resolved.overridesInvalid).toEqual(['aggregate', 'hardCeiling']);
  });

  it('resets an explicit composedPromptCap override that is too low', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      hardCeiling: 300 * 1024,
      composedPromptCap: 200 * 1024,
    });

    expect(resolved.hardCeiling).toBe(300 * 1024);
    expect(resolved.composedPromptCap).toBe(300 * 1024);
    expect(resolved.overridesInvalid).toEqual(['composedPromptCap']);
  });

  it('resets explicit composedPromptCap below the default hardCeiling back to the default composed cap', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      composedPromptCap: 100 * 1024,
    });

    expect(resolved.overridesInvalid).toContain('composedPromptCap');
    expect(resolved.hardCeiling).toBe(DEFAULT_PEER_MESSAGE_CAPS.hardCeiling);
    expect(resolved.composedPromptCap).toBe(DEFAULT_PEER_MESSAGE_CAPS.composedPromptCap);
  });

  it('silently raises default composedPromptCap when hardCeiling alone is raised above it', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      hardCeiling: 300 * 1024,
    });

    expect(resolved.hardCeiling).toBe(300 * 1024);
    expect(resolved.composedPromptCap).toBe(300 * 1024);
    expect(resolved.overridesInvalid).toBeUndefined();
  });

  it('warns but does not override when aggregate is below worst-case per item', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = validateCapRelationships({
      aggregate: 10 * 1024,
    });

    expect(resolved.aggregate).toBe(10 * 1024);
    expect(resolved.overridesInvalid).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('worst-case per-item render'));
  });

  it('reads the documented environment override names', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);

    const resolved = resolvePeerMessageCaps({
      CREW_PEER_MESSAGE_BODY_CAP_CHARS: '1234',
      CREW_PEER_MESSAGE_EXCERPT_CAP_CHARS: '2345',
      CREW_PEER_MESSAGE_MAX_EXCERPTS: '3',
      CREW_PEER_MESSAGES_MAX_ITEMS: '4',
      CREW_PEER_MESSAGES_PREPEND_CAP_CHARS: '6000',
      CREW_PEER_MESSAGES_HARD_CEILING: '7000',
      CREW_DISPATCH_PROMPT_CAP_CHARS: '8000',
    });

    expect(resolved).toMatchObject({
      body: 1234,
      excerpt: 2345,
      maxExcerpts: 3,
      maxItems: 4,
      aggregate: 6000,
      hardCeiling: 7000,
      composedPromptCap: 8000,
    });
  });
});
