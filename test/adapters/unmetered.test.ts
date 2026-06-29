import { describe, expect, it } from 'vitest';

import { isLoopbackApiBase } from '../../src/adapters/unmetered.js';

describe('isLoopbackApiBase', () => {
  it.each([
    'http://localhost:11434/v1',
    'http://127.0.0.1:11434/v1',
    'http://127.99.88.77:11434/v1',
    'http://[::1]:8080',
    'http://foo.localhost/v1',
  ])('classifies %s as loopback', (apiBase) => {
    expect(isLoopbackApiBase(apiBase)).toBe(true);
  });

  it.each([
    'https://api.openai.com/v1',
    'http://127.example.com/v1',
    'http://127.0.0.1.evil.com/v1',
    'http://127.cloud-provider.ai/v1',
    'https://example.com',
    '',
    undefined,
    'not a url',
  ])('classifies %s as metered/conservative', (apiBase) => {
    expect(isLoopbackApiBase(apiBase)).toBe(false);
  });
});
