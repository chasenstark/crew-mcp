import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  configSetCommand,
  configShowCommand,
  configUnsetCommand,
} from '../../../src/cli/commands/config.js';

class CaptureStdout {
  text = '';

  write(chunk: string | Uint8Array): boolean {
    this.text += String(chunk);
    return true;
  }
}

describe('crew-mcp config subcommands', () => {
  let cwd: string;
  let crewHome: string;

  beforeEach(() => {
    const root = join(tmpdir(), `crew-config-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(root, 'project');
    crewHome = join(root, 'home', '.crew');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(crewHome, { recursive: true });
  });

  afterEach(() => {
    rmSync(join(cwd, '..'), { recursive: true, force: true });
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
});
