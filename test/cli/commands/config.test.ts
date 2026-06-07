import { mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  configCommand,
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
} from '../../../src/cli/commands/config.js';
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
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.implementer: codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.reviewers: claude-code, codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.iterate.banList: gemini-cli\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.panel.reviewers: codex\n');
    expect(stdout.text).toContain('  workflow.agentDefaults.panel.banList: (empty)\n');
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
    expect(stdout.text.split('\n').slice(0, 9)).toEqual([
      'crew-mcp config — toggle settings',
      '',
      '> [x] notifications.success   OS toast on successful runs',
      '  [x] notifications.error     OS toast on failed or partial runs',
      '  [x] confirmBeforeMerge      Ask before merging dispatched runs (off = auto-merge)',
      '      Agent defaults...       Configure default agents for iterate and panel workflows',
      '      Cleanup & retention...  Set GC retention windows and reclaim stale worktrees/run-dirs now',
      '',
      '↑/↓ or j/k: move    space: toggle    enter: save    q / esc: cancel',
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
    // confirmBeforeMerge(2), Agent defaults(3), Cleanup(4).
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('down');
    stdin.press('return'); // push CleanupScreen
    await waitForOutput(stdout, 'Cleanup & retention');
    // Cleanup rows: worktree(0), rundir(1), criteria(2), preview(3), run(4), back(5).
    stdin.press('space'); // worktree TTL 7 → 14
    stdin.press('down'); // rundir
    stdin.press('down'); // criteria
    stdin.press('down'); // preview
    stdin.press('down'); // run
    stdin.press('return'); // "Run cleanup now" → save + run

    await expect(run).resolves.toBe(0);
    expect(stdin.isRaw).toBe(false);
    expect(readConfigFile(crewHome).cleanup.worktreeTtlDays).toBe(14);
    expect(stdout.text).toContain('crew cleanup');
    expect(stdout.text).toMatch(/Reclaimed: \d+ worktree/);
  });
});

async function waitForOutput(stdout: TtyStdout, needle: string): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (stdout.text.includes(needle)) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${needle}`);
}
