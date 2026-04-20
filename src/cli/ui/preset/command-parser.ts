/**
 * /preset slash-command parser.
 *
 * Identifier-only contract: preset names must match
 * `/^[A-Za-z0-9_-]+$/` — no shell quoting, no embedded spaces, no exotic
 * characters. This is a deliberate constraint; future contributors should
 * NOT retrofit shell-style quoting (that would be a breaking change for
 * users who typed `/preset my-preset` and expect the same semantics).
 *
 * Canonical forms only — no synonyms. `/preset off` and `/preset none` are
 * intentionally NOT aliases for `/preset clear`; scope discipline from
 * plan §7.2 limits the command to one canonical name.
 */

const PRESET_NAME_RE = /^[A-Za-z0-9_-]+$/;

export type PresetSlashCommand =
  | { kind: 'help' }
  | { kind: 'list' }
  | { kind: 'set'; name: string }
  | { kind: 'clear' }
  | { kind: 'show' }
  | { kind: 'invalid'; reason: string };

/**
 * Parse a `/preset [subcommand [arg]]` input into a discriminated command.
 * Returns `null` when the input is not a /preset invocation at all, so the
 * App's slash-command router can fall through to /cancel / /config / etc.
 *
 * Intentionally rejects `/presetbogus` (no separator) as invalid — it is
 * neither a valid `/preset` nor a different slash command, so we want the
 * user to see the error rather than silently falling through to /cancel or
 * similar.
 */
export function parsePresetSlashCommand(input: string): PresetSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/preset')) return null;

  // Reject `/presetbogus` — accepts only `/preset` alone or `/preset ` + subcommand.
  const afterPrefix = trimmed.slice('/preset'.length);
  if (afterPrefix.length > 0 && !/^\s/.test(afterPrefix)) {
    return {
      kind: 'invalid',
      reason: `Unknown command "${trimmed.split(/\s+/)[0]}". Did you mean /preset?`,
    };
  }

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return { kind: 'help' };

  const subcommand = tokens[1].toLowerCase();
  const extra = tokens.slice(2);

  if (subcommand === 'help') return { kind: 'help' };
  if (subcommand === 'list') return { kind: 'list' };
  if (subcommand === 'clear') return { kind: 'clear' };
  if (subcommand === 'show') return { kind: 'show' };

  // `/preset <name>` — treat the second token as the preset name. Any
  // trailing tokens are rejected (names cannot contain spaces).
  if (extra.length > 0) {
    return {
      kind: 'invalid',
      reason: 'Preset names cannot contain spaces. Use /preset <name>.',
    };
  }
  if (!PRESET_NAME_RE.test(tokens[1])) {
    return {
      kind: 'invalid',
      reason: `Preset name "${tokens[1]}" must match [A-Za-z0-9_-]+.`,
    };
  }
  return { kind: 'set', name: tokens[1] };
}
