import { createInterface } from 'node:readline';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';

import { OpenAiCompatibleAdapter } from '../../../adapters/openai-compatible.js';
import { BUILTIN_ADAPTER_NAMES } from '../../../adapters/registry.js';
import type { AgentPreferences } from '../../../agent-prefs/store.js';
import { resolveAgentPrefsPath } from '../../../agent-prefs/store.js';
import {
  detectLmStudio,
  detectOllama,
  LM_STUDIO_DEFAULT_API_BASE,
  OLLAMA_DEFAULT_API_BASE,
} from '../../../install/provider-detection.js';
import { listOpenAiCompatibleModels } from '../../../install/model-discovery.js';
import { resolveCrewHome } from '../../../utils/crew-home.js';
import type { PromptIO } from '../../../install/interactive-target.js';
import { mergeAgentEntries, readRawAgentPrefsFile, writeRawAgentPrefsFile } from './store.js';

export type AddProvider = 'ollama' | 'lm-studio' | 'vllm' | 'openai-compatible' | 'generic';

export interface AgentsAddOptions {
  readonly provider?: string;
  readonly apiBase?: string;
  readonly apiKey?: string;
  readonly model?: string | readonly string[];
  readonly name?: string | readonly string[];
  readonly command?: string;
  readonly args?: string | readonly string[];
  readonly strengths?: string | readonly string[];
  readonly useWhen?: string | readonly string[];
  readonly nonInteractive?: boolean;
  readonly noVerify?: boolean;
  readonly allowVerifyFailure?: boolean;
  readonly crewHome?: string;
  readonly io?: PromptIO;
  readonly isInteractive?: boolean;
  readonly detectServeRunning?: () => Promise<boolean>;
}

export interface AgentsAddResult {
  readonly added: readonly string[];
  readonly path: string;
}

interface ProviderConfig {
  readonly provider: AddProvider;
  readonly adapter: 'openai-compatible' | 'generic';
  readonly apiBase?: string;
  readonly apiKey?: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly defaultStrengths: readonly string[];
  readonly skipVerify: boolean;
}

interface ModelSelection {
  readonly model: string;
  readonly name: string;
  readonly strengths: readonly string[];
  readonly useWhen?: string;
}

const PROVIDER_CHOICES: Array<{ label: string; value: AddProvider }> = [
  { label: 'Ollama', value: 'ollama' },
  { label: 'LM Studio', value: 'lm-studio' },
  { label: 'vLLM', value: 'vllm' },
  { label: 'OpenAI-compatible URL', value: 'openai-compatible' },
  { label: 'custom shell command (generic)', value: 'generic' },
];

export async function agentsAddCommand(opts: AgentsAddOptions = {}): Promise<AgentsAddResult> {
  const crewHome = opts.crewHome ?? resolveCrewHome();
  const io = opts.io ?? defaultReadlineIO();
  const ownsIo = !opts.io;
  const interactive = opts.isInteractive ?? Boolean(process.stdin.isTTY);
  const nonInteractive = opts.nonInteractive === true || !interactive;

  try {
    const existing = readRawAgentPrefsFile(crewHome);
    const existingNames = new Set(Object.keys(existing).filter((name) => !name.startsWith('_')));
    for (const builtIn of BUILTIN_ADAPTER_NAMES) existingNames.add(builtIn);

    const provider = await resolveProviderConfig(opts, io, nonInteractive);
    const selections = await resolveSelections(provider, existingNames, opts, io, nonInteractive);
    const entries = buildEntries(provider, selections);

    validateNewEntries(entries, existing);

    if (!provider.skipVerify && !opts.noVerify) {
      for (const selection of selections) {
        const verification = await verifyOpenAiCompatibleAgent({
          name: selection.name,
          model: selection.model,
          apiBase: provider.apiBase!,
          apiKey: provider.apiKey,
          strengths: selection.strengths,
        });
        if (verification.ok) {
          io.write(`crew agents add: verified ${selection.name} (${verification.latencyMs}ms)\n`);
          continue;
        }

        const warning = `crew agents add: verify failed for ${selection.name}: ${verification.error}`;
        if (opts.allowVerifyFailure) {
          io.write(`${warning}; registering anyway because --allow-verify-failure was set.\n`);
          continue;
        }
        if (!nonInteractive) {
          const proceed = await askYesNo(
            io,
            `${warning}. Register anyway? [y/N] `,
            false,
          );
          if (proceed) continue;
        }
        throw new Error(`${warning}; no changes written.`);
      }
    }

    const merged = mergeAgentEntries(existing, entries);
    writeRawAgentPrefsFile(crewHome, merged);
    for (const name of Object.keys(entries)) {
      io.write(`crew agents add: registered ${name}\n`);
    }
    if (await (opts.detectServeRunning ?? isCrewMcpServeRunning)()) {
      io.write('crew-mcp serve appears to be running.\n');
    }
    io.write('Restart `crew-mcp serve` for the new entries to load.\n');
    return { added: Object.keys(entries), path: resolveAgentPrefsPath(crewHome) };
  } finally {
    if (ownsIo && 'close' in io && typeof (io as { close: unknown }).close === 'function') {
      (io as { close: () => void }).close();
    }
  }
}

async function isCrewMcpServeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('ps', ['-axo', 'pid=,command='], (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      const currentPid = String(process.pid);
      resolve(stdout
        .split('\n')
        .some((line) => {
          const trimmed = line.trim();
          if (!trimmed) return false;
          const [pid, ...commandParts] = trimmed.split(/\s+/);
          if (pid === currentPid) return false;
          const command = commandParts.join(' ');
          return /\bcrew-mcp\b/.test(command) && /\bserve\b/.test(command);
        }));
    });
  });
}

async function resolveProviderConfig(
  opts: AgentsAddOptions,
  io: PromptIO,
  nonInteractive: boolean,
): Promise<ProviderConfig> {
  const provider = normalizeProvider(
    opts.provider
      ?? (nonInteractive
        ? undefined
        : await selectOne(io, 'What kind of provider?', PROVIDER_CHOICES)),
  );
  if (!provider) {
    throw new Error('crew agents add: --provider is required in non-interactive mode.');
  }

  if (provider === 'generic') {
    const command = opts.command ?? await promptRequired(
      io,
      'Command to run for this agent: ',
      nonInteractive,
      '--command is required for --provider generic',
    );
    const rawArgs = opts.args ?? (
      nonInteractive
        ? undefined
        : await promptWithDefault(io, 'Args template (comma-separated)', '{{prompt}}')
    );
    const args = normalizeArgs(rawArgs);
    return {
      provider,
      adapter: 'generic',
      command,
      args: args.length > 0 ? args : ['{{prompt}}'],
      defaultStrengths: [],
      skipVerify: true,
    };
  }

  const defaultStrengths = defaultStrengthsForProvider(provider);
  let apiBase = opts.apiBase?.trim();
  let apiKey = opts.apiKey?.trim();

  if (provider === 'ollama') {
    if (!apiBase) {
      const probe = await detectOllama();
      if (!probe.reachable) {
        if (nonInteractive) {
          throw new Error(
            `crew agents add: Ollama was not reachable at ${probe.url}: ${probe.reason}. `
            + 'Start Ollama or pass --api-base.',
          );
        }
        io.write(`crew agents add: Ollama was not reachable at ${probe.url}: ${probe.reason}\n`);
        const custom = await askYesNo(io, 'Enter a custom URL instead? [Y/n] ', true);
        if (!custom) throw new Error('crew agents add: cancelled.');
        apiBase = await promptRequired(io, 'OpenAI-compatible base URL: ', false, '');
      } else {
        apiBase = OLLAMA_DEFAULT_API_BASE;
      }
    }
    if (!apiKey) {
      apiKey = 'ollama';
      io.write(
        'Ollama does not use an API key; writing apiKey "ollama" because the OpenAI client requires a non-empty value.\n',
      );
    }
  } else if (provider === 'lm-studio') {
    if (!apiBase) {
      const probe = await detectLmStudio();
      if (!probe.reachable) {
        if (nonInteractive) {
          throw new Error(
            `crew agents add: LM Studio was not reachable at ${probe.url}: ${probe.reason}. `
            + 'Start LM Studio or pass --api-base.',
          );
        }
        io.write(`crew agents add: LM Studio was not reachable at ${probe.url}: ${probe.reason}\n`);
        const custom = await askYesNo(io, 'Enter a custom URL instead? [Y/n] ', true);
        if (!custom) throw new Error('crew agents add: cancelled.');
        apiBase = await promptRequired(io, 'OpenAI-compatible base URL: ', false, '');
      } else {
        apiBase = LM_STUDIO_DEFAULT_API_BASE;
      }
    }
    if (!apiKey) {
      apiKey = 'ollama';
      io.write(
        'LM Studio local endpoints usually do not use an API key; writing apiKey "ollama" because the OpenAI client requires a non-empty value.\n',
      );
    }
  } else {
    // vLLM may be unauthenticated, but requiring an explicit sentinel keeps keyless writes intentional.
    apiBase ??= await promptRequired(
      io,
      'OpenAI-compatible base URL: ',
      nonInteractive,
      '--api-base is required for this provider',
    );
    if (apiKey === undefined && !nonInteractive) {
      apiKey = (await io.question('API key (blank allowed for self-hosted): ')).trim();
    }
    if (!apiKey) {
      if (nonInteractive) {
        throw new Error(
          `crew agents add: --api-key is required for --provider ${provider} `
          + '(pass a literal sentinel like \'local\' for self-hosted endpoints that ignore the header).',
        );
      }
      const proceed = await askYesNo(
        io,
        'No API key set. This is OK for local/self-hosted; for hosted endpoints, requests will fail. Continue with the \'local\' sentinel? [y/N] ',
        false,
      );
      if (!proceed) throw new Error('crew agents add: cancelled.');
      apiKey = 'local';
      io.write(
        'No API key provided; writing apiKey "local" as a local/self-hosted sentinel because the OpenAI client requires a non-empty value.\n',
      );
    }
  }

  return {
    provider,
    adapter: 'openai-compatible',
    apiBase: normalizeApiBase(apiBase),
    apiKey,
    defaultStrengths,
    skipVerify: false,
  };
}

async function resolveSelections(
  provider: ProviderConfig,
  existingNames: Set<string>,
  opts: AgentsAddOptions,
  io: PromptIO,
  nonInteractive: boolean,
): Promise<ModelSelection[]> {
  if (provider.adapter === 'generic') {
    const name = normalizeSingle(opts.name)
      ?? await promptRequired(io, 'Agent name: ', nonInteractive, '--name is required');
    const strengths = parseStrengths(opts.strengths, provider.defaultStrengths);
    const useWhen = normalizeUseWhen(opts.useWhen);
    return [{ model: name, name, strengths, ...(useWhen ? { useWhen } : {}) }];
  }

  let models = normalizeList(opts.model);
  if (models.length === 0) {
    if (nonInteractive) {
      throw new Error('crew agents add: --model is required in non-interactive mode.');
    }
    const discovered = await listOpenAiCompatibleModels(provider.apiBase!, provider.apiKey);
    if (discovered.ok) {
      models = await selectMany(
        io,
        'Choose model(s) to register',
        discovered.models.map((model) => ({ label: model, value: model })),
      );
    } else {
      io.write(
        `crew agents add: could not auto-discover models (${discovered.reason}); enter one manually.\n`,
      );
      models = [await promptRequired(io, 'Model id: ', false, '')];
    }
  }

  const names = normalizeList(opts.name);
  const selections: ModelSelection[] = [];
  const claimed = new Set(existingNames);
  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const defaultName = dedupeAgentName(defaultAgentName(model), claimed);
    const name = names[i]
      ?? (nonInteractive
        ? defaultName
        : await promptWithDefault(io, `Agent name for ${model}`, defaultName));
    claimed.add(name);
    const strengths = parseStrengths(
      pickListValue(opts.strengths, i),
      provider.defaultStrengths,
    );
    const useWhen = normalizeUseWhen(pickListValue(opts.useWhen, i));
    if (!nonInteractive && opts.strengths === undefined) {
      const rawStrengths = await promptWithDefault(
        io,
        `Strengths for ${name} (comma-separated)`,
        provider.defaultStrengths.join(', '),
      );
      selections.push({
        model,
        name,
        strengths: parseStrengths(rawStrengths, []),
        ...(useWhen ? { useWhen } : {}),
      });
    } else {
      selections.push({ model, name, strengths, ...(useWhen ? { useWhen } : {}) });
    }
  }
  return selections;
}

function buildEntries(
  provider: ProviderConfig,
  selections: readonly ModelSelection[],
): Record<string, AgentPreferences> {
  const entries: Record<string, AgentPreferences> = {};
  for (const selection of selections) {
    if (Object.prototype.hasOwnProperty.call(entries, selection.name)) {
      throw new Error(`crew agents add: duplicate agent name "${selection.name}".`);
    }
    if (provider.adapter === 'generic') {
      entries[selection.name] = {
        adapter: 'generic',
        command: provider.command,
        args: provider.args,
        strengths: selection.strengths,
        ...(selection.useWhen ? { useWhen: selection.useWhen } : {}),
      };
      continue;
    }
    entries[selection.name] = {
      adapter: 'openai-compatible',
      model: selection.model,
      apiBase: provider.apiBase,
      apiKey: provider.apiKey,
      strengths: selection.strengths,
      ...(selection.useWhen ? { useWhen: selection.useWhen } : {}),
    };
  }
  return entries;
}

function validateNewEntries(
  entries: Record<string, AgentPreferences>,
  existing: Record<string, unknown>,
): void {
  const names = Object.keys(entries);
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) {
    throw new Error(`crew agents add: duplicate agent name "${duplicate}".`);
  }

  for (const name of names) {
    if (!isValidAgentName(name)) {
      throw new Error(
        `crew agents add: "${name}" is not a valid agent name. Use lowercase letters, numbers, and hyphens.`,
      );
    }
    if ((BUILTIN_ADAPTER_NAMES as readonly string[]).includes(name)) {
      throw new Error(`crew agents add: "${name}" is a built-in agent name; choose a custom name.`);
    }
    if (Object.prototype.hasOwnProperty.call(existing, name)) {
      throw new Error(`crew agents add: "${name}" already exists in agents.json; no changes written.`);
    }
  }
}

async function verifyOpenAiCompatibleAgent(args: {
  readonly name: string;
  readonly model: string;
  readonly apiBase: string;
  readonly apiKey?: string;
  readonly strengths: readonly string[];
}): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const adapter = new OpenAiCompatibleAdapter({
    name: args.name,
    model: args.model,
    apiBase: args.apiBase,
    apiKey: args.apiKey,
    strengths: [...args.strengths],
  });
  const start = performance.now();
  try {
    const result = await adapter.execute({
      prompt: 'respond with the single word ok',
      context: { workingDirectory: process.cwd() },
      constraints: { timeout: 30_000 },
    });
    const latencyMs = Math.round(performance.now() - start);
    if (result.output.trim().toLowerCase() === 'ok') {
      return { ok: true, latencyMs };
    }
    return { ok: false, error: `expected "ok", got "${result.output.trim() || '<empty>'}"` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeProvider(raw: string | undefined): AddProvider | undefined {
  if (!raw) return undefined;
  const token = raw.trim().toLowerCase();
  if (token === 'ollama') return 'ollama';
  if (token === 'lm-studio' || token === 'lmstudio' || token === 'lm studio') return 'lm-studio';
  if (token === 'vllm' || token === 'vllm-compatible') return 'vllm';
  if (token === 'openai-compatible' || token === 'openai' || token === 'url') return 'openai-compatible';
  if (token === 'generic' || token === 'shell') return 'generic';
  throw new Error(`crew agents add: unsupported provider "${raw}".`);
}

function normalizeApiBase(apiBase: string | undefined): string {
  const trimmed = apiBase?.trim();
  if (!trimmed) throw new Error('crew agents add: api base URL is required.');
  return trimmed.replace(/\/+$/, '');
}

function defaultStrengthsForProvider(provider: AddProvider): readonly string[] {
  if (provider === 'ollama') return ['local', 'private'];
  if (provider === 'lm-studio' || provider === 'vllm') return ['local'];
  return [];
}

function normalizeList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalizeSingle(value: string | readonly string[] | undefined): string | undefined {
  return normalizeList(value)[0];
}

function normalizeUseWhen(value: string | readonly string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = raw?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function pickListValue(
  value: string | readonly string[] | undefined,
  index: number,
): string | readonly string[] | undefined {
  if (!Array.isArray(value)) return value;
  return value[index];
}

function normalizeArgs(value: string | readonly string[] | undefined): string[] {
  const items = normalizeList(value);
  if (items.length === 0) return [];
  return items.flatMap((item) => item.split(/\s+/).filter((part) => part.length > 0));
}

function parseStrengths(
  value: string | readonly string[] | undefined,
  defaults: readonly string[],
): string[] {
  const items = normalizeList(value);
  if (items.length === 0) return [...defaults];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function defaultAgentName(model: string): string {
  const stripped = model.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  return stripped || 'agent';
}

function dedupeAgentName(base: string, existing: Set<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function isValidAgentName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name);
}

async function promptRequired(
  io: PromptIO,
  prompt: string,
  nonInteractive: boolean,
  missingMessage: string,
): Promise<string> {
  if (nonInteractive) {
    throw new Error(`crew agents add: ${missingMessage}.`);
  }
  const value = (await io.question(prompt)).trim();
  if (!value) throw new Error('crew agents add: value is required.');
  return value;
}

async function promptWithDefault(
  io: PromptIO,
  label: string,
  defaultValue: string,
): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  const value = (await io.question(`${label}${suffix}: `)).trim();
  return value || defaultValue;
}

async function askYesNo(io: PromptIO, prompt: string, defaultYes: boolean): Promise<boolean> {
  const value = (await io.question(prompt)).trim().toLowerCase();
  if (!value) return defaultYes;
  return value === 'y' || value === 'yes';
}

async function selectOne<T extends string>(
  io: PromptIO,
  title: string,
  choices: readonly { label: string; value: T }[],
): Promise<T> {
  io.write(`${title}\n`);
  choices.forEach((choice, index) => {
    io.write(`  ${index + 1}) ${choice.label}\n`);
  });
  const raw = (await io.question('> ')).trim();
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 1 || index > choices.length) {
    throw new Error(`crew agents add: "${raw}" is not a valid choice.`);
  }
  return choices[index - 1].value;
}

async function selectMany<T extends string>(
  io: PromptIO,
  title: string,
  choices: readonly { label: string; value: T }[],
): Promise<T[]> {
  io.write(`${title}\n`);
  choices.forEach((choice, index) => {
    io.write(`  ${index + 1}) ${choice.label}\n`);
  });
  io.write('Enter comma-separated numbers, or blank to cancel.\n');
  const raw = (await io.question('> ')).trim();
  if (!raw) throw new Error('crew agents add: cancelled.');
  const values: T[] = [];
  const seen = new Set<T>();
  for (const part of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const index = Number(part);
    if (!Number.isInteger(index) || index < 1 || index > choices.length) {
      throw new Error(`crew agents add: "${part}" is not a valid choice.`);
    }
    const value = choices[index - 1].value;
    if (!seen.has(value)) {
      seen.add(value);
      values.push(value);
    }
  }
  return values;
}

function defaultReadlineIO(): PromptIO & { close(): void } {
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
