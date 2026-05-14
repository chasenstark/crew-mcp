import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import chalk from 'chalk';

import {
  BUILTIN_ADAPTER_NAMES,
  createBuiltinRegistry,
  mergeCustomAgents,
  type AdapterRegistry,
} from '../../adapters/registry.js';
import {
  readAgentPrefsFile,
  resolveAgentPrefsPath,
  seedAgentPrefsFile,
  type AgentPrefsMap,
} from '../../agent-prefs/store.js';
import type { PromptIO } from '../../install/interactive-target.js';
import { resolveCrewHome } from '../../utils/crew-home.js';
import { logger } from '../../utils/logger.js';
import { agentsAddCommand, type AgentsAddOptions } from './agents/add.js';
import { readRawAgentPrefsFile, writeRawAgentPrefsFile } from './agents/store.js';

export function registerAgentsCommand(program: Command, applyDebugFlag: () => void): void {
  const agents = program
    .command('agents')
    .description('Manage per-machine agent preferences and custom dispatch agents');

  agents
    .command('edit')
    .description('Open ~/.crew/agents.json in $EDITOR (creates with defaults if missing)')
    .action(async () => {
      applyDebugFlag();
      const code = await agentsEditCommand();
      if (code !== 0) process.exitCode = code;
    });

  agents
    .command('list')
    .description('List configured agents and health status')
    .action(async () => {
      applyDebugFlag();
      await agentsListCommand();
    });

  agents
    .command('add')
    .description('Interactively register a custom dispatch agent')
    .option('--provider <provider>', 'ollama | lm-studio | vllm | openai-compatible | generic')
    .option('--api-base <url>', 'OpenAI-compatible base URL')
    .option('--api-key <key>', 'API key or local-provider sentinel')
    .option('--model <model>', 'Model id to register; repeat or comma-separate for multiple', collect, [])
    .option('--name <name>', 'Agent name; repeat alongside --model for multiple', collect, [])
    .option('--command <command>', 'Shell command for --provider generic')
    .option('--args <args>', 'Args template for --provider generic')
    .option('--strengths <items>', 'Comma-separated strengths')
    .option('--non-interactive', 'Fail instead of prompting when required flags are missing')
    .option('--no-verify', 'Skip the verification chat completion')
    .option('--allow-verify-failure', 'Write the entry even if verification fails')
    .action(async (opts: AgentsAddOptions & { verify?: boolean }) => {
      applyDebugFlag();
      try {
        await agentsAddCommand({
          ...opts,
          noVerify: opts.verify === false,
        });
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });

  agents
    .command('remove')
    .description('Remove a custom dispatch agent from ~/.crew/agents.json')
    .argument('<name>', 'Custom agent name to remove')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(async (name: string, opts: { yes?: boolean }) => {
      applyDebugFlag();
      try {
        const removed = await agentsRemoveCommand(name, { yes: opts.yes });
        if (!removed) process.exitCode = 1;
      } catch (err) {
        logger.error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    });
}

export async function agentsEditCommand(): Promise<number> {
  const crewHome = resolveCrewHome();
  const path = resolveAgentPrefsPath(crewHome);

  if (!existsSync(path)) {
    seedAgentPrefsFile(crewHome, collectAdapterDefaults());
    logger.info(`crew agents edit: created ${path} with adapter defaults`);
  }

  const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
  // Edit-mode commands like `vi` need to attach to the user's TTY for
  // both input + output, so inherit stdio rather than capturing.
  const child = spawn(editor, [path], { stdio: 'inherit' });
  return new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      logger.error(`crew agents edit: failed to launch editor "${editor}" — ${err.message}`);
      resolve(1);
    });
  });
}

export interface AgentsListOptions {
  readonly crewHome?: string;
  readonly registry?: AdapterRegistry;
  readonly stdout?: Pick<NodeJS.WriteStream, 'write'>;
}

export async function agentsListCommand(opts: AgentsListOptions = {}): Promise<void> {
  const crewHome = opts.crewHome ?? resolveCrewHome();
  const registry = opts.registry ?? createRegistryForAgentsFile(crewHome);
  const stdout = opts.stdout ?? process.stdout;
  const prefs = readAgentPrefsFile(crewHome);
  const adapters = registry.listAvailable();
  const health = await registry.healthCheckAll();

  stdout.write(`${chalk.bold('Agent')}  ${chalk.bold('Health')}  ${chalk.bold('Strengths')}\n`);
  for (const adapter of adapters) {
    const result = health[adapter.name] ?? {
      available: false,
      authenticated: false,
      error: 'health check did not return a result',
    };
    const healthText = formatHealth(result);
    const configured = prefs[adapter.name];
    const strengths = configured?.strengths ?? adapter.strengths;
    stdout.write(`${adapter.name.padEnd(16)} ${healthText.padEnd(28)} ${strengths.join(', ')}\n`);
  }
  stdout.write('\nRun `crew-mcp agents add` to register more models, or `crew-mcp agents edit` to tweak this file directly.\n');
}

export interface AgentsRemoveOptions {
  readonly crewHome?: string;
  readonly yes?: boolean;
  readonly io?: PromptIO;
}

export async function agentsRemoveCommand(
  name: string,
  opts: AgentsRemoveOptions = {},
): Promise<boolean> {
  if ((BUILTIN_ADAPTER_NAMES as readonly string[]).includes(name)) {
    throw new Error(`crew agents remove: "${name}" is built in and cannot be removed.`);
  }

  const crewHome = opts.crewHome ?? resolveCrewHome();
  const raw = readRawAgentPrefsFile(crewHome);
  if (!Object.prototype.hasOwnProperty.call(raw, name)) {
    throw new Error(`crew agents remove: "${name}" is not in agents.json.`);
  }

  if (!opts.yes) {
    const io = opts.io ?? defaultStdioPrompt();
    const ownsIo = !opts.io;
    try {
      const answer = (await io.question(`Remove agent "${name}"? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        io.write('crew agents remove: cancelled.\n');
        return false;
      }
    } finally {
      if (ownsIo && 'close' in io && typeof (io as { close: unknown }).close === 'function') {
        (io as { close: () => void }).close();
      }
    }
  }

  const next = { ...raw };
  delete next[name];
  writeRawAgentPrefsFile(crewHome, next);
  logger.info(`crew agents remove: removed ${name}`);
  return true;
}

function collectAdapterDefaults(): AgentPrefsMap {
  const registry = createBuiltinRegistry();
  const defaults: AgentPrefsMap = {};
  for (const adapter of registry.listAvailable()) {
    defaults[adapter.name] = {
      strengths: [...adapter.strengths],
      ...(adapter.defaultEffort ? { effort: adapter.defaultEffort } : {}),
    };
  }
  return defaults;
}

function createRegistryForAgentsFile(crewHome: string): AdapterRegistry {
  const registry = createBuiltinRegistry();
  const prefs = readAgentPrefsFile(crewHome);
  const result = mergeCustomAgents(registry, prefs);
  for (const warning of result.warnings) {
    logger.warn(warning);
  }
  return registry;
}

function formatHealth(result: {
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}): string {
  if (result.available) {
    return result.version ? `available (${result.version})` : 'available';
  }
  return result.error ? `unavailable (${result.error})` : 'unavailable';
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function defaultStdioPrompt(): PromptIO & { close(): void } {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return {
    write(line) {
      process.stdout.write(line);
    },
    question(prompt) {
      return new Promise((resolve) => rl.question(prompt, resolve));
    },
    close() {
      rl.close();
    },
  };
}
