/**
 * /preset slash-command handler.
 *
 * Unlike /config, preset switching does NOT gate on `sessionBusy` — it's
 * safe mid-run. A preset is prompt material (rendered once per captain
 * turn via buildCaptainSystemPrompt); subagent tool_calls in flight see
 * their own `run_agent(prompt=...)` input verbatim and are unaffected by
 * a captain-side preset swap.
 *
 * Effective at the NEXT captain turn: the current turn's system prompt was
 * built at turn-start and isn't re-rendered. Subagents still running
 * continue their work unchanged.
 */

import type { CaptainSession } from '../../../captain/session.js';
import type { FullConfig, PresetConfig } from '../../../workflow/types.js';
import { resolveActivePreset } from '../../../captain/preset-resolver.js';
import { parsePresetSlashCommand } from './command-parser.js';

export interface HandlePresetCommandOptions {
  readonly session: CaptainSession;
  readonly config: FullConfig;
}

function presetsMap(config: FullConfig): Record<string, PresetConfig> {
  return config.presets ?? {};
}

function helpText(config: FullConfig): string {
  const declared = Object.keys(presetsMap(config)).sort();
  const listHint = declared.length > 0
    ? `Available: ${declared.join(', ')}`
    : 'No presets declared (edit workflow.yaml to add some).';
  return [
    'Preset commands:',
    '  /preset              Show this help',
    '  /preset help         Show this help',
    '  /preset list         List declared presets',
    '  /preset show         Show the currently-active preset',
    '  /preset <name>       Set the session preset (takes effect next turn)',
    '  /preset clear        Clear the session override (fall back to config default)',
    listHint,
  ].join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

function formatListTable(
  presets: Record<string, PresetConfig>,
  activeName: string | undefined,
): string {
  const entries = Object.entries(presets).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    return 'No presets declared.';
  }
  const rows = entries.map(([name, preset]) => {
    const marker = name === activeName ? '*' : ' ';
    const description = preset.description?.trim() ?? '(no description)';
    return `${marker} ${name}  —  ${truncate(description, 120)}`;
  });
  return ['Presets (* = active):', ...rows].join('\n');
}

/**
 * Handle a `/preset <command>` input. Returns the message text to display
 * to the user, or null if `input` is not a /preset invocation at all.
 *
 * Does NOT call `setActivePreset` on unknown-preset errors — the invariant
 * is "user typo leaves the current active preset untouched" (plan §M5-7).
 */
export function handlePresetSlashCommand(
  input: string,
  options: HandlePresetCommandOptions,
): string | null {
  const parsed = parsePresetSlashCommand(input);
  if (!parsed) return null;

  const { session, config } = options;
  const presets = presetsMap(config);

  if (parsed.kind === 'help') return helpText(config);

  if (parsed.kind === 'list') {
    const active = resolveActivePreset({
      presets,
      defaultPresetName: config.captain.preset,
      sessionOverride: session.activePreset,
    });
    return formatListTable(presets, active?.name);
  }

  if (parsed.kind === 'show') {
    const active = resolveActivePreset({
      presets,
      defaultPresetName: config.captain.preset,
      sessionOverride: session.activePreset,
    });
    if (!active) {
      return 'No active preset. (/preset <name> to set one.)';
    }
    const descr = active.preset.description?.trim() || '(no description)';
    const hintExcerpt = active.preset.hint?.trim()
      ? truncate(active.preset.hint.trim(), 200)
      : '(no hint)';
    const roles = active.preset.suggestedAgentRoles?.length
      ? `  suggested roles: ${active.preset.suggestedAgentRoles.join(', ')}`
      : undefined;
    const scope = session.activePreset
      ? `(session override)`
      : `(from captain.preset)`;
    const lines = [
      `Active preset: ${active.name} ${scope}`,
      `  description: ${descr}`,
      `  hint: ${hintExcerpt}`,
    ];
    if (roles) lines.push(roles);
    return lines.join('\n');
  }

  if (parsed.kind === 'clear') {
    session.setActivePreset(undefined);
    const fallback = config.captain.preset
      ? `'${config.captain.preset}'`
      : '(none)';
    return `Preset override cleared. Captain will use the config default ${fallback} on the next turn.`;
  }

  if (parsed.kind === 'invalid') {
    return `${parsed.reason}\nTry /preset help.`;
  }

  // parsed.kind === 'set'
  const target = presets[parsed.name];
  if (!target) {
    // CRITICAL: do NOT mutate session.activePreset on unknown name. Locked
    // by test/cli/ui/preset/command-handler.test.ts.
    const declared = Object.keys(presets).sort();
    const suggestion = declared.length > 0
      ? `Available: ${declared.join(', ')}.`
      : 'No presets are declared.';
    return `Unknown preset '${parsed.name}'. ${suggestion} Try /preset list.`;
  }

  session.setActivePreset(parsed.name);
  const descr = target.description?.trim();
  const descrPart = descr ? ` ('${descr}')` : '';
  return `Preset set to '${parsed.name}'${descrPart}. Takes effect on the captain's next turn.`;
}
