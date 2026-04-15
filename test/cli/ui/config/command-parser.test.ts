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

  it('parses profile get/set commands', () => {
    expect(parseConfigSlashCommand('/config profile')).toEqual({ kind: 'profile:get' });
    expect(parseConfigSlashCommand('/config profile codex-first')).toEqual({
      kind: 'profile:set',
      profile: 'codex-first',
    });
  });

  it('parses set command values with spaces', () => {
    expect(parseConfigSlashCommand('/config set captain.model claude sonnet')).toEqual({
      kind: 'set',
      path: 'captain.model',
      value: 'claude sonnet',
    });
  });

  it('parses add-agent command', () => {
    expect(parseConfigSlashCommand('/config add-agent gemma generic ollama')).toEqual({
      kind: 'add-agent',
      name: 'gemma',
      adapter: 'generic',
      command: 'ollama',
    });
  });

  it('parses remove-agent command', () => {
    expect(parseConfigSlashCommand('/config remove-agent gemma')).toEqual({
      kind: 'remove-agent',
      name: 'gemma',
    });
  });

  it('returns invalid for malformed set command', () => {
    const parsed = parseConfigSlashCommand('/config set captain.model');
    expect(parsed).toEqual({
      kind: 'invalid',
      reason: 'Usage: /config set <path> <value>',
    });
  });

  it('returns invalid for unsupported set paths', () => {
    const parsed = parseConfigSlashCommand('/config set workflow.name new-name');
    expect(parsed).toEqual({
      kind: 'invalid',
      reason: 'Unsupported config path "workflow.name".',
    });
  });

  it('returns invalid for malformed add-agent command', () => {
    const parsed = parseConfigSlashCommand('/config add-agent');
    expect(parsed).toEqual({
      kind: 'invalid',
      reason: 'Usage: /config add-agent <name> [adapter] [command]',
    });
  });
});
