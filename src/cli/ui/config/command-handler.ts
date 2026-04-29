import {
  addAgent,
  getConfigProfile,
  getConfigScope,
  removeAgent,
  resetConfig,
  setConfigProfile,
  setConfigScope,
  setConfigValue,
} from '../../../workflow/config-service.js';
import { AdapterId } from '../../../workflow/agents.js';
import { configPathHelpLines } from '../../../workflow/config-path-registry.js';
import { formatChangedValue, formatShowOutput } from '../../commands/config.js';
import { parseConfigSlashCommand } from './command-parser.js';

// Post-M1.5, the captain is always available — "is the session running?" is
// no longer a single boolean. `sessionBusy` means subagent tool calls are in
// flight, which is the condition under which we block config mutations.
interface HandleConfigCommandOptions {
  cwd: string;
  sessionBusy: boolean;
}

function helpText(): string {
  const setExamples = configPathHelpLines().map((line) => `  ${line}`);
  return [
    'Config commands:',
    '  /config',
    '  /config help',
    '  /config show',
    '  /config setup',
    '  /config scope',
    '  /config scope project',
    '  /config scope global',
    '  /config profile',
    '  /config profile <name>',
    '  /config edit',
    '  /config add-agent <name> [adapter] [command]',
    '  /config remove-agent <name>',
    ...setExamples,
    '  /config reset',
  ].join('\n');
}

function sessionBusyMutationBlocked(): string {
  return 'Cannot mutate config while subagent tool calls are in flight. Wait for completion or use /cancel-all first.';
}

export function handleConfigSlashCommand(
  input: string,
  options: HandleConfigCommandOptions,
): string | null {
  const parsed = parseConfigSlashCommand(input);
  if (!parsed) return null;

  if (parsed.kind === 'help') return helpText();
  if (parsed.kind === 'show') return formatShowOutput(options.cwd, false);
  if (parsed.kind === 'scope:get') {
    return `Active write scope: ${getConfigScope(options.cwd)}`;
  }
  if (parsed.kind === 'profile:get') {
    return `Active profile: ${getConfigProfile(options.cwd)}`;
  }

  if (parsed.kind === 'invalid') {
    return `${parsed.reason}\nTry /config help`;
  }

  if (options.sessionBusy) {
    return sessionBusyMutationBlocked();
  }

  if (parsed.kind === 'setup' || parsed.kind === 'edit') {
    return [
      'Guided config setup is available in the dedicated terminal command.',
      'Run: crew config setup',
      'It asks questions about the captain, models, presets, agents, review passes, and retries before writing workflow.yaml.',
    ].join('\n');
  }

  if (parsed.kind === 'scope:set') {
    const result = setConfigScope(options.cwd, parsed.scope);
    return [
      `\u2713 Active write scope set to ${result.scope}.`,
      `file: ${result.scopePath}`,
    ].join('\n');
  }

  if (parsed.kind === 'profile:set') {
    const result = setConfigProfile(options.cwd, parsed.profile);
    return [
      `\u2713 Active profile set to ${result.profile}.`,
      `file: ${result.profilePath}`,
    ].join('\n');
  }

  if (parsed.kind === 'add-agent') {
    const result = addAgent(options.cwd, parsed.name, {
      adapter: parsed.adapter,
      command: parsed.command,
    });
    return [
      '\u2713 Agent added.',
      `scope: ${result.scope}`,
      `profile: ${result.profile}`,
      `file: ${result.filePath}`,
      `name: ${result.name}`,
      `adapter: ${result.agent.adapter ?? AdapterId.GENERIC}`,
      `command: ${result.agent.command ?? '(none)'}`,
    ].join('\n');
  }

  if (parsed.kind === 'remove-agent') {
    const result = removeAgent(options.cwd, parsed.name);
    return [
      '\u2713 Agent removed.',
      `scope: ${result.scope}`,
      `profile: ${result.profile}`,
      `file: ${result.filePath}`,
      `name: ${result.name}`,
    ].join('\n');
  }

  if (parsed.kind === 'set') {
    const result = setConfigValue(options.cwd, parsed.path, parsed.value);
    return [
      '\u2713 Configuration updated.',
      `scope: ${result.scope}`,
      `profile: ${result.profile}`,
      `file: ${result.filePath}`,
      `path: ${result.path}`,
      `value: ${formatChangedValue(result.previousValue)} -> ${formatChangedValue(result.nextValue)}`,
    ].join('\n');
  }

  if (parsed.kind === 'reset') {
    const result = resetConfig(options.cwd);
    return [
      '\u2713 Scope config reset to defaults.',
      `scope: ${result.scope}`,
      `profile: ${result.profile}`,
      `file: ${result.filePath}`,
    ].join('\n');
  }

  return null;
}
