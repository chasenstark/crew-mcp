import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger } from '../../src/utils/logger.js';

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  spawn: mockSpawn,
}));

const {
  buildTerminalNotificationCommand,
  notifyTerminal,
  osNotificationsEnabled,
} = await import('../../src/orchestrator/notifications.js');

function mockSpawnChild(): EventEmitter & { unref: () => void } {
  const child = new EventEmitter() as EventEmitter & { unref: () => void };
  child.unref = vi.fn();
  mockSpawn.mockReturnValue(child);
  return child;
}

function expectedCommandForCurrentPlatform() {
  if (process.platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e',
        'display notification "run abcdef12 success" with title "crew: codex"',
      ],
    };
  }
  if (process.platform === 'win32') {
    return {
      command: 'powershell',
      argsPrefix: ['-NoProfile', '-Command'],
    };
  }
  return {
    command: 'notify-send',
    args: ['crew: codex', 'run abcdef12 success'],
  };
}

describe('notifications', () => {
  const originalEnv = process.env.CREW_OS_NOTIFICATIONS;

  beforeEach(() => {
    mockSpawn.mockReset();
    delete process.env.CREW_OS_NOTIFICATIONS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalEnv === undefined) {
      delete process.env.CREW_OS_NOTIFICATIONS;
    } else {
      process.env.CREW_OS_NOTIFICATIONS = originalEnv;
    }
  });

  it('disables OS notifications only when CREW_OS_NOTIFICATIONS=off', () => {
    expect(osNotificationsEnabled()).toBe(true);
    process.env.CREW_OS_NOTIFICATIONS = 'off';
    expect(osNotificationsEnabled()).toBe(false);
    process.env.CREW_OS_NOTIFICATIONS = 'OFF';
    expect(osNotificationsEnabled()).toBe(true);
  });

  it('does not spawn when env-var disabled', () => {
    process.env.CREW_OS_NOTIFICATIONS = 'off';
    notifyTerminal({ runId: 'abcdef123456', agentId: 'codex', status: 'success' });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns the notification command for the current platform by default', () => {
    const child = mockSpawnChild();
    notifyTerminal({ runId: 'abcdef123456', agentId: 'codex', status: 'success' });

    const expected = expectedCommandForCurrentPlatform();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn.mock.calls[0][0]).toBe(expected.command);
    if ('argsPrefix' in expected) {
      expect(mockSpawn.mock.calls[0][1]).toEqual([
        ...expected.argsPrefix,
        expect.stringContaining("New-BurntToastNotification -Text @('crew: codex', 'run abcdef12 success')"),
      ]);
    } else {
      expect(mockSpawn.mock.calls[0][1]).toEqual(expected.args);
    }
    expect(mockSpawn.mock.calls[0][2]).toEqual({ detached: true, stdio: 'ignore' });
    expect(child.unref).toHaveBeenCalled();
  });

  it('builds platform-specific commands', () => {
    const input = { runId: 'abcdef123456', agentId: 'codex', status: 'error' as const };

    expect(buildTerminalNotificationCommand(input, 'darwin')).toEqual({
      command: 'osascript',
      args: ['-e', 'display notification "run abcdef12 error" with title "crew: codex"'],
    });
    expect(buildTerminalNotificationCommand(input, 'linux')).toEqual({
      command: 'notify-send',
      args: ['crew: codex', 'run abcdef12 error'],
    });
    const win = buildTerminalNotificationCommand(input, 'win32');
    expect(win.command).toBe('powershell');
    expect(win.args[2]).toContain('BurntToast');
    expect(win.args[2]).toContain('[System.Windows.Forms.MessageBox]::Show');
  });

  it('does not throw and logs when spawn throws synchronously', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    mockSpawn.mockImplementation(() => {
      throw new Error('missing binary');
    });

    expect(() => {
      notifyTerminal({ runId: 'abcdef123456', agentId: 'codex', status: 'error' });
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Failed to fire OS notification for terminal run',
      expect.objectContaining({
        runId: 'abcdef123456',
        agentId: 'codex',
        status: 'error',
      }),
    );
  });

  it('does not throw and logs when the spawned process emits error', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const child = mockSpawnChild();

    expect(() => {
      notifyTerminal({ runId: 'abcdef123456', agentId: 'codex', status: 'error' });
      child.emit('error', new Error('notify-send missing'));
    }).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      'Failed to fire OS notification for terminal run',
      expect.objectContaining({
        runId: 'abcdef123456',
        agentId: 'codex',
        status: 'error',
      }),
    );
  });
});
