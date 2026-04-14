import type { ConfigScope } from '../../../workflow/config-repository.js';

export type ConfigSlashCommand =
  | { kind: 'help' }
  | { kind: 'show' }
  | { kind: 'edit' }
  | { kind: 'reset' }
  | { kind: 'scope:get' }
  | { kind: 'scope:set'; scope: ConfigScope }
  | { kind: 'set'; path: string; value: string }
  | { kind: 'invalid'; reason: string };

export function parseConfigSlashCommand(input: string): ConfigSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/config')) return null;

  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) return { kind: 'help' };

  const subcommand = tokens[1].toLowerCase();

  if (subcommand === 'help') return { kind: 'help' };
  if (subcommand === 'show') return { kind: 'show' };
  if (subcommand === 'edit') return { kind: 'edit' };
  if (subcommand === 'reset') return { kind: 'reset' };

  if (subcommand === 'scope') {
    if (tokens.length === 2) return { kind: 'scope:get' };
    const rawScope = tokens[2];
    if (rawScope === 'project' || rawScope === 'global') {
      return { kind: 'scope:set', scope: rawScope };
    }
    return { kind: 'invalid', reason: `Invalid scope "${rawScope}". Expected "project" or "global".` };
  }

  if (subcommand === 'set') {
    if (tokens.length < 4) {
      return {
        kind: 'invalid',
        reason: 'Usage: /config set <path> <value>',
      };
    }
    return {
      kind: 'set',
      path: tokens[2],
      value: tokens.slice(3).join(' '),
    };
  }

  return {
    kind: 'invalid',
    reason: `Unknown /config command "${subcommand}".`,
  };
}
