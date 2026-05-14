import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdapterRegistry } from '../../../src/adapters/registry.js';
import type { AgentAdapter } from '../../../src/adapters/types.js';
import { resolveAgentPrefsPath } from '../../../src/agent-prefs/store.js';
import {
  agentsListCommand,
  agentsRemoveCommand,
} from '../../../src/cli/commands/agents.js';
import { agentsAddCommand } from '../../../src/cli/commands/agents/add.js';
import type { PromptIO } from '../../../src/install/interactive-target.js';

let crewHome: string;

beforeEach(() => {
  crewHome = mkdtempSync(join(tmpdir(), 'crew-agents-command-'));
});

afterEach(() => {
  rmSync(crewHome, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

describe('agents add', () => {
  it('adds an Ollama model entry and preserves existing entries', async () => {
    writeJson({
      _readme: ['keep me'],
      codex: { strengths: ['fast-iteration'], effort: 'medium' },
      existing: {
        adapter: 'generic',
        command: 'echo',
        args: ['{{prompt}}'],
        strengths: ['scriptable'],
      },
    });
    const fetchMock = vi.fn(async (url: string | URL) => {
      const textUrl = String(url);
      if (textUrl === 'http://localhost:11434') {
        return { ok: true, status: 200 } as Response;
      }
      if (textUrl === 'http://localhost:11434/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await addAgent({
      crewHome,
      nonInteractive: true,
      provider: 'ollama',
      model: 'gemma4:latest',
      name: 'gemma4',
    });

    expect(result.added).toEqual(['gemma4']);
    expect(readJson()).toEqual({
      _readme: ['keep me'],
      codex: { strengths: ['fast-iteration'], effort: 'medium' },
      existing: {
        adapter: 'generic',
        command: 'echo',
        args: ['{{prompt}}'],
        strengths: ['scriptable'],
      },
      gemma4: {
        adapter: 'openai-compatible',
        model: 'gemma4:latest',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'ollama',
        strengths: ['local', 'private'],
      },
    });
  });

  it('does not write a partial file when the default local endpoint is unreachable', async () => {
    writeJson({ codex: { strengths: ['keep'] } });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as Response));

    await expect(
      addAgent({
        crewHome,
        nonInteractive: true,
        provider: 'ollama',
        model: 'gemma4:latest',
        name: 'gemma4',
      }),
    ).rejects.toThrow(/Ollama was not reachable/);

    expect(readJson()).toEqual({ codex: { strengths: ['keep'] } });
  });

  it('aborts with no write when the verify ping fails', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const textUrl = String(url);
      if (textUrl === 'http://localhost:11434') return { ok: true, status: 200 } as Response;
      if (textUrl === 'http://localhost:11434/v1/chat/completions') {
        return {
          ok: false,
          status: 500,
          text: async () => 'boom',
        } as Response;
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      addAgent({
        crewHome,
        nonInteractive: true,
        provider: 'ollama',
        model: 'gemma4:latest',
        name: 'gemma4',
      }),
    ).rejects.toThrow(/verify failed/);

    expect(existsSync(resolveAgentPrefsPath(crewHome))).toBe(false);
  });

  it('writes when verify fails and --allow-verify-failure is set', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const textUrl = String(url);
      if (textUrl === 'http://localhost:11434') return { ok: true, status: 200 } as Response;
      if (textUrl === 'http://localhost:11434/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'not ok' } }] }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await addAgent({
      crewHome,
      nonInteractive: true,
      provider: 'ollama',
      model: 'gemma4:latest',
      name: 'gemma4',
      allowVerifyFailure: true,
    });

    expect(readJson().gemma4).toMatchObject({
      adapter: 'openai-compatible',
      model: 'gemma4:latest',
    });
  });

  it('rejects reserved built-in names before writing', async () => {
    await expect(
      addAgent({
        crewHome,
        nonInteractive: true,
        provider: 'openai-compatible',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'local',
        model: 'gemma4:latest',
        name: 'claude-code',
        noVerify: true,
      }),
    ).rejects.toThrow(/built-in agent name/);

    expect(existsSync(resolveAgentPrefsPath(crewHome))).toBe(false);
  });

  it('preserves existing entries across add with no verify', async () => {
    writeJson({
      _readme: ['seed text'],
      'claude-code': { strengths: ['review'] },
      shell: { adapter: 'generic', command: 'echo', args: ['{{prompt}}'] },
    });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));

    await addAgent({
      crewHome,
      nonInteractive: true,
      provider: 'ollama',
      model: 'llama-3.2:latest',
      name: 'llama-32',
      noVerify: true,
    });

    expect(readJson()).toMatchInlineSnapshot(`
      {
        "_readme": [
          "seed text",
        ],
        "claude-code": {
          "strengths": [
            "review",
          ],
        },
        "llama-32": {
          "adapter": "openai-compatible",
          "apiBase": "http://localhost:11434/v1",
          "apiKey": "ollama",
          "model": "llama-3.2:latest",
          "strengths": [
            "local",
            "private",
          ],
        },
        "shell": {
          "adapter": "generic",
          "args": [
            "{{prompt}}",
          ],
          "command": "echo",
        },
      }
    `);
  });

  it('--no-verify skips the chat completion fetch', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    await addAgent({
      crewHome,
      nonInteractive: true,
      provider: 'ollama',
      model: 'gemma4:latest',
      name: 'gemma4',
      noVerify: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:11434');
  });

  it('prompts for a generic args template in interactive mode', async () => {
    const output: string[] = [];
    const io = promptIo(['node', 'agent.js, --prompt, {{prompt}}', 'local-shell'], output);

    await agentsAddCommand({
      crewHome,
      provider: 'generic',
      isInteractive: true,
      io,
      detectServeRunning: async () => false,
    });

    expect(readJson()['local-shell']).toEqual({
      adapter: 'generic',
      command: 'node',
      args: ['agent.js', '--prompt', '{{prompt}}'],
      strengths: [],
    });
  });

  it('requires an explicit api key for non-interactive OpenAI-compatible providers', async () => {
    await expect(
      addAgent({
        crewHome,
        nonInteractive: true,
        provider: 'openai-compatible',
        apiBase: 'https://foo/v1',
        model: 'bar',
        name: 'baz',
      }),
    ).rejects.toThrow(/--api-key is required for --provider openai-compatible/);

    expect(existsSync(resolveAgentPrefsPath(crewHome))).toBe(false);
  });

  it('adds an Ollama model through the interactive prompt flow', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const textUrl = String(url);
      if (textUrl === 'http://localhost:11434') return { ok: true, status: 200 } as Response;
      if (textUrl === 'http://localhost:11434/v1/models') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'gemma4:latest' }] }),
        } as Response;
      }
      if (textUrl === 'http://localhost:11434/v1/chat/completions') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
        } as Response;
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const output: string[] = [];
    const io = promptIo(['1', 'gemma4', 'local, coding'], output);

    const result = await agentsAddCommand({
      crewHome,
      provider: 'ollama',
      isInteractive: true,
      io,
      detectServeRunning: async () => false,
    });

    expect(result.added).toEqual(['gemma4']);
    expect(readJson().gemma4).toEqual({
      adapter: 'openai-compatible',
      model: 'gemma4:latest',
      apiBase: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      strengths: ['local', 'coding'],
    });
    expect(output.join('')).toContain('Choose model(s) to register');
  });

  it('rejects an existing custom agent name without changing agents.json', async () => {
    writeJson({
      gemma4: {
        adapter: 'openai-compatible',
        model: 'gemma4:latest',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'ollama',
        strengths: ['local'],
      },
    });
    const before = readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 }) as Response));

    await expect(
      addAgent({
        crewHome,
        nonInteractive: true,
        provider: 'ollama',
        model: 'gemma4:latest',
        name: 'gemma4',
      }),
    ).rejects.toThrow(/"gemma4" already exists in agents\.json/);

    const after = readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8');
    expect(after).toBe(before);
  });

  it('writes in interactive mode when verify fails and the user confirms', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const textUrl = String(url);
      if (textUrl === 'http://localhost:11434') return { ok: true, status: 200 } as Response;
      if (textUrl === 'http://localhost:11434/v1/chat/completions') {
        return {
          ok: false,
          status: 500,
          text: async () => 'boom',
        } as Response;
      }
      throw new Error(`unexpected fetch ${textUrl}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const output: string[] = [];
    const io = promptIo(['', 'y'], output);

    await agentsAddCommand({
      crewHome,
      provider: 'ollama',
      model: 'gemma4:latest',
      name: 'gemma4',
      isInteractive: true,
      io,
      detectServeRunning: async () => false,
    });

    expect(readJson().gemma4).toMatchObject({
      adapter: 'openai-compatible',
      model: 'gemma4:latest',
    });
    expect(output.join('')).toContain('verify failed for gemma4');
  });
});

describe('agents list', () => {
  it('shows configured entries with a health column', async () => {
    writeJson({
      custom: {
        adapter: 'openai-compatible',
        model: 'custom-model',
        apiBase: 'http://localhost:11434/v1',
        apiKey: 'ollama',
        strengths: ['local'],
      },
    });
    const registry = makeRegistry([
      makeAdapter('claude-code', ['code-review']),
      makeAdapter('custom', ['local'], 'ollama 0.9.0'),
    ]);
    let output = '';

    await agentsListCommand({
      crewHome,
      registry,
      stdout: { write: (chunk: string | Uint8Array) => { output += String(chunk); return true; } },
    });

    expect(output).toContain('Health');
    expect(output).toContain('claude-code');
    expect(output).toContain('available');
    expect(output).toContain('custom');
    expect(output).toContain('available (ollama 0.9.0)');
    expect(output).toContain('crew-mcp agents add');
  });
});

describe('agents remove', () => {
  it('refuses to remove built-in agents', async () => {
    await expect(
      agentsRemoveCommand('claude-code', { crewHome, yes: true }),
    ).rejects.toThrow(/built in/);
  });

  it('removes a custom entry and preserves the rest of agents.json', async () => {
    writeJson({
      _readme: ['keep'],
      codex: { strengths: ['fast'] },
      gemma4: { adapter: 'openai-compatible', apiBase: 'http://localhost:11434/v1' },
      shell: { adapter: 'generic', command: 'echo' },
    });

    await expect(
      agentsRemoveCommand('gemma4', { crewHome, yes: true }),
    ).resolves.toBe(true);

    expect(readJson()).toEqual({
      _readme: ['keep'],
      codex: { strengths: ['fast'] },
      shell: { adapter: 'generic', command: 'echo' },
    });
  });
});

function writeJson(value: Record<string, unknown>): void {
  writeFileSync(resolveAgentPrefsPath(crewHome), JSON.stringify(value, null, 2), 'utf-8');
}

function readJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(resolveAgentPrefsPath(crewHome), 'utf-8')) as Record<string, unknown>;
}

function addAgent(opts: Parameters<typeof agentsAddCommand>[0]): ReturnType<typeof agentsAddCommand> {
  return agentsAddCommand({
    ...opts,
    io: {
      write: () => undefined,
      question: async () => {
        throw new Error('unexpected prompt in test');
      },
    },
    detectServeRunning: async () => false,
  });
}

function promptIo(answers: readonly string[], output: string[] = []): PromptIO {
  const queue = [...answers];
  return {
    write: (chunk) => {
      output.push(String(chunk));
    },
    question: async (prompt) => {
      output.push(prompt);
      const answer = queue.shift();
      if (answer === undefined) throw new Error(`unexpected prompt in test: ${prompt}`);
      return answer;
    },
  };
}

function makeAdapter(name: string, strengths: readonly string[], version?: string): AgentAdapter {
  return {
    name,
    strengths,
    supportsJsonSchema: false,
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true, version }),
  };
}

function makeRegistry(adapters: readonly AgentAdapter[]): AdapterRegistry {
  const registry = new AdapterRegistry();
  for (const adapter of adapters) {
    registry.register(adapter);
  }
  return registry;
}
