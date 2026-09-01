import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
  driveTui,
} from '../../../src/cli/commands/config.js';
import type { Screen, TuiKey } from '../../../src/cli/commands/config-tui/screen.js';
import { readConfigFile } from '../../../src/utils/config-store.js';

// workflow.agentDefaults.* writes resolve to the GLOBAL workflow config
// (~/.crew/workflow.yaml via os.homedir()), so mock homedir to keep the
// test off the real user config.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

class CaptureStdout {
  text = '';

  write(chunk: string | Uint8Array): boolean {
    this.text += String(chunk);
    return true;
  }
}

class TtyStdout extends EventEmitter {
  text = '';
  isTTY = true;
  columns = 160;

  write(chunk: string | Uint8Array): boolean {
    this.text += String(chunk);
    return true;
  }
}

class TtyStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(value: boolean): this {
    this.isRaw = value;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  press(name: string, ctrl = false): void {
    this.emit('keypress', undefined, { name, ctrl });
  }
}

describe('crew-mcp config subcommands', () => {
  const mockedHomedir = vi.mocked(homedir);
  let cwd: string;
  let crewHome: string;

  beforeEach(() => {
    const root = join(tmpdir(), `crew-config-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(root, 'project');
    crewHome = join(root, 'home', '.crew');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(crewHome, { recursive: true });
    // Global workflow config (~/.crew/workflow.yaml) resolves via
    // homedir(); point it at the test root so agentDefaults writes stay
    // isolated.
    mockedHomedir.mockReturnValue(join(root, 'home'));
  });

  afterEach(() => {
    rmSync(join(cwd, '..'), { recursive: true, force: true });
    mockedHomedir.mockRestore();
  });

  it('sets, shows, and unsets workflow agentDefaults dotted keys', async () => {
    await configSetCommand(
      'workflow.agentDefaults.iterate.implementer',
      'codex',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );
    await configSetCommand(
      'workflow.agentDefaults.iterate.banList',
      '["gemini-cli"]',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );

    const shown = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: shown });
    expect(JSON.parse(shown.text).workflow.agentDefaults.iterate).toEqual({
      implementer: 'codex',
      banList: ['gemini-cli'],
    });

    await configUnsetCommand(
      'workflow.agentDefaults.iterate.banList',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );
    const afterUnset = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: afterUnset });
    expect(JSON.parse(afterUnset.text).workflow.agentDefaults.iterate).toEqual({
      implementer: 'codex',
    });
  });

  it('keeps notification settings round-tripping through set/show/unset', async () => {
    await configSetCommand('notifications.success', 'off', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    await configSetCommand('notifications.error', 'on', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });

    const shown = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: shown });
    expect(JSON.parse(shown.text).notifications).toEqual({
      success: false,
      error: true,
    });

    await configUnsetCommand('notifications.success', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    const afterUnset = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: afterUnset });
    expect(JSON.parse(afterUnset.text).notifications.success).toBe(true);
  });

  it('keeps confirmBeforeMerge round-tripping through set/show/unset', async () => {
    await configSetCommand('confirmBeforeMerge', 'false', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    const shown = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: shown });
    expect(JSON.parse(shown.text).confirmBeforeMerge).toBe(false);

    await configUnsetCommand('confirmBeforeMerge', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    const afterUnset = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: afterUnset });
    expect(JSON.parse(afterUnset.text).confirmBeforeMerge).toBe(true);
  });

  it('sets, validates, shows, and unsets crew-iterate limits', async () => {
    await configSetCommand('iterate.maxRoundsPerEpoch', '5', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    await configSetCommand('iterate.maxTotalRounds', '15', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });

    await configSetCommand('iterate.checkInMinutes', '5', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });

    const shown = new CaptureStdout();
    await configShowCommand('iterate', { cwd, crewHome, stdout: shown });
    expect(JSON.parse(shown.text)).toEqual({
      maxRoundsPerEpoch: 5,
      maxTotalRounds: 15,
      checkInMinutes: 5,
    });

    await expect(configSetCommand('iterate.maxTotalRounds', '4', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    })).rejects.toThrow(/must be greater than or equal/);
    await expect(configSetCommand('iterate.maxRoundsPerEpoch', '0', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    })).rejects.toThrow(/positive integer/);
    await expect(configSetCommand('iterate.checkInMinutes', '0', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    })).rejects.toThrow(/positive integer/);
    await expect(configSetCommand('iterate.checkInMinutes', '1441', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    })).rejects.toThrow(/-1 or 1\.\.1440/);
    await configSetCommand('iterate.checkInMinutes', '-1', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    expect(readConfigFile(crewHome).iterate).toEqual({
      maxRoundsPerEpoch: 5,
      maxTotalRounds: 15,
      checkInMinutes: -1,
    });

    await configUnsetCommand('iterate.maxTotalRounds', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    await configUnsetCommand('iterate.maxRoundsPerEpoch', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    await configUnsetCommand('iterate.checkInMinutes', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    expect(readConfigFile(crewHome).iterate).toEqual({
      maxRoundsPerEpoch: 3,
      maxTotalRounds: 9,
      checkInMinutes: 10,
    });
  });

  it('sets, shows, and unsets exact provider model defaults', async () => {
    const resolveProviderModel = vi.fn(async (_providerName: string, requested: string) => ({
      ok: true as const,
      argument: requested.trim(),
      displayName: requested.trim(),
      validation: 'catalog' as const,
    }));

    await configSetCommand('providerModels.codex', '  gpt-5.6-sol  ', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
      resolveProviderModel,
    });

    const shown = new CaptureStdout();
    await configShowCommand(undefined, { cwd, crewHome, stdout: shown });
    expect(JSON.parse(shown.text).providerModels).toEqual({
      'claude-code': null,
      codex: 'gpt-5.6-sol',
      agy: null,
    });
    expect(resolveProviderModel).toHaveBeenCalledWith('codex', '  gpt-5.6-sol  ');

    await configUnsetCommand('providerModels.codex', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
    });
    const afterUnset = new CaptureStdout();
    await configShowCommand('providerModels.codex', { cwd, crewHome, stdout: afterUnset });
    expect(JSON.parse(afterUnset.text)).toBeNull();
  });

  it('refuses an invalid provider model without changing agents.json', async () => {
    writeFileSync(
      join(crewHome, 'agents.json'),
      JSON.stringify({ codex: { strengths: ['keep'] } }),
      'utf-8',
    );

    await expect(configSetCommand('providerModels.codex', 'bogus', {
      cwd,
      crewHome,
      stdout: new CaptureStdout(),
      resolveProviderModel: async () => ({
        ok: false,
        code: 'model_selection.unknown',
        message: 'model_selection.unknown: bogus',
      }),
    })).rejects.toThrow(/model_selection\.unknown/);

    expect(JSON.parse(
      readFileSync(join(crewHome, 'agents.json'), 'utf-8'),
    )).toEqual({ codex: { strengths: ['keep'] } });
  });

  it('prints agent defaults in the non-TTY config summary', async () => {
    await configSetCommand(
      'workflow.agentDefaults.iterate.implementer',
      'codex',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );
    await configSetCommand(
      'workflow.agentDefaults.iterate.reviewers',
      '["claude-code","codex"]',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );
    await configSetCommand(
      'workflow.agentDefaults.iterate.banList',
      '["gemini-cli"]',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );
    await configSetCommand(
      'workflow.agentDefaults.panel.reviewers',
      '["codex"]',
      { cwd, crewHome, stdout: new CaptureStdout() },
    );

    const stdout = new CaptureStdout();
    const code = await configCommand({
      cwd,
      crewHome,
      stdin: { isTTY: false } as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    expect(code).toBe(1);
    expect(stdout.text).toContain('  notifications.success: on\n');
    expect(stdout.text).toContain('  iterate.maxRoundsPerEpoch: 3\n');
    expect(stdout.text).toContain('  iterate.maxTotalRounds: 9\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.implementer: codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.reviewers: claude-code, codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.banList: gemini-cli\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.panel.reviewers: codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.panel.banList: (empty)\n');
    expect(stdout.text).toContain('  providerModels.claude-code: (provider CLI default)\n');
    expect(stdout.text).toContain('  providerModels.codex: (provider CLI default)\n');
    expect(stdout.text).toContain('  providerModels.agy: (provider CLI default)\n');
  });

  it('preserves existing three-toggle TUI rendering and save behavior', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    const run = configCommand({
      cwd,
      crewHome,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      listAgentInventory: async () => ({
        agentIds: ['codex'],
        knownIds: new Set(['codex']),
      }),
    });

    await waitForOutput(stdout, 'crew-mcp config — toggle settings');
    expect(stdout.text.split('\n').slice(0, 10)).toEqual([
      'crew-mcp config — toggle settings',
      '',
      '> [x] notifications.success   OS toast on successful runs',
      '  [x] notifications.error     OS toast on failed or partial runs',
      '  [x] confirmBeforeMerge      Ask before merging dispatched runs (off = auto-merge)',
      '      Agent defaults...       Configure default agents for iterate and panel workflows',
      '      Provider models...      Choose the default model for each provider',
      '      Agent strengths...      Tune per-agent routing prose and strength tags',
      '      Iteration limits...     Set crew-iterate round limits and the watcher check-in cadence',
      '      Cleanup & retention...  Set GC retention windows and reclaim stale worktrees/run-dirs now',
    ]);

    stdin.press('space');
    stdin.press('down');
    stdin.press('space');
    stdin.press('return');
    await expect(run).resolves.toBe(0);
    expect(stdin.isRaw).toBe(false);
    expect(readConfigFile(crewHome)).toMatchObject({
      notifications: {
        success: false,
        error: false,
      },
      confirmBeforeMerge: true,
    });
  });

  it('surfaces corrupt agents.json errors from the agent strengths save path', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    writeFileSync(join(crewHome, 'agents.json'), JSON.stringify([]), 'utf-8');
    const run = configCommand({
      cwd,
      crewHome,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      listAgentInventory: async () => ({
        agentIds: ['codex'],
        knownIds: new Set(['codex']),
        agents: [{ name: 'codex', strengths: ['fast-iteration'] }],
      }),
    });

    await waitForOutput(stdout, 'crew-mcp config — toggle settings');
    stdin.press('down'); // notifications.error
    stdin.press('down'); // confirmBeforeMerge
    stdin.press('down'); // Agent defaults
    stdin.press('down'); // Provider models
    stdin.press('down'); // Agent strengths
    stdin.press('space'); // open AgentStrengthsListScreen
    stdin.press('space'); // open AgentStrengthEditScreen for codex
    stdin.press('space'); // open StrengthsMultiSelectScreen
    stdin.press('space'); // deselect fast-iteration
    stdin.press('return'); // commit strengths: [] and save the whole config

    await expect(run).resolves.toBe(1);
    expect(stdin.isRaw).toBe(false);
    expect(stdout.text).toContain('could not save agent strengths');
    expect(stdout.text).toContain('must be a JSON object');
  });

  it('selects and persists a provider model default through the TUI', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    const resolveProviderModel = vi.fn(async (_providerName: string, requested: string) => ({
      ok: true as const,
      argument: requested,
      displayName: 'GPT-5.6 Sol',
      validation: 'catalog' as const,
    }));
    const run = configCommand({
      cwd,
      crewHome,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      listAgentInventory: async () => ({
        agentIds: ['codex'],
        knownIds: new Set(['codex']),
        providerModels: [{
          name: 'codex',
          displayName: 'Codex',
          models: [{ model: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' }],
        }],
        resolveProviderModel,
      }),
    });

    await waitForOutput(stdout, 'crew-mcp config — toggle settings');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down'); // Agent defaults
    stdin.press('down'); // Provider models
    stdin.press('space');
    await waitForOutput(stdout, 'Provider model defaults');
    stdin.press('space'); // open Codex picker
    stdin.press('down'); // gpt-5.6-sol
    stdin.press('space'); // select and return to provider list
    stdin.press('return'); // save

    await expect(run).resolves.toBe(0);
    expect(resolveProviderModel).toHaveBeenCalledWith('codex', 'gpt-5.6-sol');
    expect(JSON.parse(readFileSync(join(crewHome, 'agents.json'), 'utf-8'))).toEqual({
      codex: { model: 'gpt-5.6-sol' },
    });
  });

  it('does not write any TUI settings when provider validation refuses the model', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    const run = configCommand({
      cwd,
      crewHome,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      listAgentInventory: async () => ({
        agentIds: ['codex'],
        knownIds: new Set(['codex']),
        providerModels: [{
          name: 'codex',
          displayName: 'Codex',
          models: [{ model: 'bogus', displayName: 'Bogus' }],
        }],
        resolveProviderModel: async () => ({
          ok: false,
          code: 'model_selection.unknown',
          message: 'model_selection.unknown: bogus',
        }),
      }),
    });

    await waitForOutput(stdout, 'crew-mcp config — toggle settings');
    stdin.press('space'); // also toggle notifications.success off
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down'); // Provider models
    stdin.press('space');
    stdin.press('space'); // open Codex picker
    stdin.press('down');
    stdin.press('space'); // choose bogus
    stdin.press('return');

    await expect(run).resolves.toBe(1);
    expect(stdout.text).toContain('could not save provider model defaults');
    expect(stdout.text).toContain('model_selection.unknown: bogus');
    expect(readConfigFile(crewHome).notifications.success).toBe(true);
    expect(() => readFileSync(join(crewHome, 'agents.json'), 'utf-8')).toThrow();
  });

  it('opens the cleanup submenu, persists a TTL change, and runs cleanup on "Run now"', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    const run = configCommand({
      cwd,
      crewHome,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      listAgentInventory: async () => ({ agentIds: [], knownIds: new Set() }),
    });

    await waitForOutput(stdout, 'crew-mcp config — toggle settings');
    // Root rows: notifications.success(0), notifications.error(1),
    // confirmBeforeMerge(2), Agent defaults(3), Provider models(4),
    // Agent strengths(5), Iteration limits(6), Cleanup(7).
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('space'); // open CleanupScreen
    await waitForOutput(stdout, 'Cleanup & retention');
    // Cleanup rows: worktree(0), rundir(1), criteria(2), preview(3), run(4), back(5).
    stdin.press('space'); // worktree TTL 7 → 14
    stdin.press('down'); // rundir
    stdin.press('down'); // criteria
    stdin.press('down'); // preview
    stdin.press('down'); // run
    stdin.press('space'); // "Run cleanup now" → save + run

    await expect(run).resolves.toBe(0);
    expect(stdin.isRaw).toBe(false);
    expect(readConfigFile(crewHome).cleanup.worktreeTtlDays).toBe(14);
    expect(stdout.text).toContain('crew cleanup');
    expect(stdout.text).toMatch(/Reclaimed: \d+ worktree/);
  });
});

describe('driveTui central save validation', () => {
  it('blocks a save from any screen when beforeSave errors, then allows it', async () => {
    const stdin = new TtyStdin();
    const stdout = new TtyStdout();
    let allow = false;
    const screen: Screen = {
      render: () => ['stub screen'],
      onKey: (key: TuiKey) => (key.name === 'return' ? 'save' : 'continue'),
    };

    const run = driveTui({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      screens: [screen],
      beforeSave: () => (allow ? undefined : 'Conflict: fix before saving.'),
    });

    stdin.press('return'); // save attempt is gated and blocked
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stdout.text).toContain('Conflict: fix before saving.');
    expect(stdin.isRaw).toBe(true); // still open

    allow = true;
    stdin.press('return'); // now the save is permitted
    await expect(run).resolves.toBe('saved');
    expect(stdin.isRaw).toBe(false);
  });
});

async function waitForOutput(stdout: TtyStdout, needle: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (stdout.text.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${needle}`);
}
