import {
  addAgent,
  getConfigScope,
  removeAgent,
  resetConfig,
  setConfigScope,
  setConfigValue,
} from '../../../workflow/config-service.js';
import { formatShowOutput } from '../../commands/config.js';
import { parseConfigSlashCommand } from './command-parser.js';

interface HandleConfigCommandOptions {
  cwd: string;
  isRunning: boolean;
}

function formatChangedValue(value: unknown): string {
  if (typeof value === 'string') return `"${value}"`;
  return JSON.stringify(value);
}

function helpText(): string {
  return [
    'Config commands:',
    '  /config',
    '  /config help',
    '  /config show',
    '  /config scope',
    '  /config scope project',
    '  /config scope global',
    '  /config edit',
    '  /config add-agent <name> [adapter] [command]',
    '  /config remove-agent <name>',
    '  /config set orchestrator.cli <value>',
    '  /config set orchestrator.model <value>',
    '  /config set orchestrator.model next',
    '  /config set workflow.roleModels.<role> <value>',
    '  /config set workflow.roleModels.reviewer next',
    '  /config set agents.<name>.adapter <value>',
    '  /config set agents.<name>.model <value>',
    '  /config set agents.<name>.command <value>',
    '  /config set agents.<name>.args <csv|json>',
    '  /config set agents.<name>.capabilities <csv|json>',
    '  /config set agents.<name>.model prev',
    '  /config set workflow.reviewer.maxPasses <number>',
    '  /config set errorHandling.default.retry <number>',
    '  /config reset',
  ].join('\n');
}

function runningMutationBlocked(): string {
  return 'Cannot mutate config while a workflow is running. Wait for completion or use /cancel first.';
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

  if (parsed.kind === 'invalid') {
    return `${parsed.reason}\nTry /config help`;
  }

  if (options.isRunning) {
    return runningMutationBlocked();
  }

  if (parsed.kind === 'edit') {
    return [
      'Interactive editing is available in the dedicated config command.',
      'Run: orchestrator config edit',
    ].join('\n');
  }

  if (parsed.kind === 'scope:set') {
    const result = setConfigScope(options.cwd, parsed.scope);
    return [
      `\u2713 Active write scope set to ${result.scope}.`,
      `file: ${result.scopePath}`,
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
      `file: ${result.filePath}`,
      `name: ${result.name}`,
      `adapter: ${result.agent.adapter ?? 'generic'}`,
      `command: ${result.agent.command ?? '(none)'}`,
    ].join('\n');
  }

  if (parsed.kind === 'remove-agent') {
    const result = removeAgent(options.cwd, parsed.name);
    return [
      '\u2713 Agent removed.',
      `scope: ${result.scope}`,
      `file: ${result.filePath}`,
      `name: ${result.name}`,
    ].join('\n');
  }

  if (parsed.kind === 'set') {
    const result = setConfigValue(options.cwd, parsed.path, parsed.value);
    return [
      '\u2713 Configuration updated.',
      `scope: ${result.scope}`,
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
      `file: ${result.filePath}`,
    ].join('\n');
  }

  return null;
}
