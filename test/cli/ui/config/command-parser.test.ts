import { describe, expect, it } from 'vitest';
import { parseConfigSlashCommand } from '../../../../src/cli/ui/config/command-parser.js';

describe('parseConfigSlashCommand', () => {
  it('returns null for non-config input', () => {
    expect(parseConfigSlashCommand('hello')).toBeNull();
  });

  it('maps /config to help', () => {
    expect(parseConfigSlashCommand('/config')).toEqual({ kind: 'help' });
  });

  it('parses show command', () => {
    expect(parseConfigSlashCommand('/config show')).toEqual({ kind: 'show' });
  });

  it('parses scope get/set commands', () => {
    expect(parseConfigSlashCommand('/config scope')).toEqual({ kind: 'scope:get' });
    expect(parseConfigSlashCommand('/config scope project')).toEqual({
      kind: 'scope:set',
      scope: 'project',
    });
  });

  it('parses set command values with spaces', () => {
    expect(parseConfigSlashCommand('/config set orchestrator.model claude sonnet')).toEqual({
      kind: 'set',
      path: 'orchestrator.model',
      value: 'claude sonnet',
    });
  });

  it('returns invalid for malformed set command', () => {
    const parsed = parseConfigSlashCommand('/config set orchestrator.model');
    expect(parsed).toEqual({
      kind: 'invalid',
      reason: 'Usage: /config set <path> <value>',
    });
  });
});
