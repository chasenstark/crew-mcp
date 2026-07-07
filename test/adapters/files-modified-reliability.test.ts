import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { GenericAdapter } from '../../src/adapters/generic.js';
import { OpenAiCompatibleAdapter } from '../../src/adapters/openai-compatible.js';

describe('adapter filesModified reliability', () => {
  it('documents which terminal adapters can skip post-run git status', () => {
    expect(new CodexAdapter().filesModifiedReliable).toBe(true);
    expect(new ClaudeCodeAdapter().filesModifiedReliable).toBe(false);
    expect(new OpenAiCompatibleAdapter({ name: 'openai-test' }).filesModifiedReliable).toBe(false);
    expect(new GenericAdapter({
      name: 'generic-test',
      command: 'generic',
      argsTemplate: [],
      strengths: [],
    }).filesModifiedReliable).toBe(false);
  });
});

describe('adapter read-only enforcement capability', () => {
  it('documents which adapters can enforce read_only at the filesystem layer', () => {
    expect(new CodexAdapter().enforcesReadOnly).toBe(true);
    expect(new ClaudeCodeAdapter().enforcesReadOnly).toBe(false);
    expect(new OpenAiCompatibleAdapter({ name: 'openai-test' }).enforcesReadOnly).toBe(false);
    expect(new GenericAdapter({
      name: 'generic-test',
      command: 'generic',
      argsTemplate: [],
      strengths: [],
    }).enforcesReadOnly).toBe(false);
  });
});
