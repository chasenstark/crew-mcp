import { describe, expect, it } from 'vitest';
import { parsePresetSlashCommand } from '../../../../src/cli/ui/preset/command-parser.js';

describe('parsePresetSlashCommand (M5-5)', () => {
  it('returns null for non-/preset input (falls through to other routers)', () => {
    expect(parsePresetSlashCommand('hello')).toBeNull();
    expect(parsePresetSlashCommand('/config show')).toBeNull();
    expect(parsePresetSlashCommand('/cancel')).toBeNull();
  });

  it('bare /preset → help', () => {
    expect(parsePresetSlashCommand('/preset')).toEqual({ kind: 'help' });
  });

  it('/preset help → help', () => {
    expect(parsePresetSlashCommand('/preset help')).toEqual({ kind: 'help' });
  });

  it('/preset list → list', () => {
    expect(parsePresetSlashCommand('/preset list')).toEqual({ kind: 'list' });
  });

  it('/preset show → show', () => {
    expect(parsePresetSlashCommand('/preset show')).toEqual({ kind: 'show' });
  });

  it('/preset clear → clear', () => {
    expect(parsePresetSlashCommand('/preset clear')).toEqual({ kind: 'clear' });
  });

  it('/preset <name> → set', () => {
    expect(parsePresetSlashCommand('/preset thorough-review'))
      .toEqual({ kind: 'set', name: 'thorough-review' });
    expect(parsePresetSlashCommand('/preset read_only'))
      .toEqual({ kind: 'set', name: 'read_only' });
  });

  it('trailing whitespace is trimmed', () => {
    expect(parsePresetSlashCommand('  /preset list  '))
      .toEqual({ kind: 'list' });
  });

  it('/preset with a trailing space is treated as bare help (not invalid)', () => {
    expect(parsePresetSlashCommand('/preset ')).toEqual({ kind: 'help' });
  });

  describe('routing-collision cases', () => {
    it('/presetbogus (no space separator) parses as invalid, NOT as /preset with a junk arg or a spillover into /cancel', () => {
      const result = parsePresetSlashCommand('/presetbogus');
      expect(result?.kind).toBe('invalid');
      if (result?.kind === 'invalid') {
        expect(result.reason).toMatch(/Unknown command/);
      }
    });

    it('/preset= (no space) is invalid', () => {
      const result = parsePresetSlashCommand('/preset=thorough');
      expect(result?.kind).toBe('invalid');
    });
  });

  describe('identifier-only contract', () => {
    it('rejects names with spaces (shell quoting is NOT supported)', () => {
      const result = parsePresetSlashCommand('/preset "quoted name"');
      expect(result?.kind).toBe('invalid');
    });

    it('rejects names with exotic characters', () => {
      const result = parsePresetSlashCommand('/preset my.preset');
      expect(result?.kind).toBe('invalid');
    });

    it('accepts alphanumerics, underscores, and hyphens', () => {
      for (const name of ['Default', 'thorough-review', 'read_only', 'preset1', 'A-B_C-123']) {
        expect(parsePresetSlashCommand(`/preset ${name}`))
          .toEqual({ kind: 'set', name });
      }
    });
  });
});
