import { spawn } from 'node:child_process';

import { logger } from '../utils/logger.js';
import type { RunStatus } from './run-state.js';

interface TerminalNotification {
  readonly runId: string;
  readonly agentId: string;
  readonly status: Extract<RunStatus, 'success' | 'partial' | 'error' | 'cancelled'>;
}

interface NotificationCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export function osNotificationsEnabled(): boolean {
  return process.env.CREW_OS_NOTIFICATIONS !== 'off';
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function escapeAppleScriptString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapePowerShellSingleQuotedString(value: string): string {
  return value.replace(/'/g, "''");
}

export function buildTerminalNotificationCommand(
  notification: TerminalNotification,
  platform: NodeJS.Platform = process.platform,
): NotificationCommand {
  const runShort = notification.runId.slice(0, 8);
  const title = oneLine(`crew: ${notification.agentId}`);
  const text = oneLine(`run ${runShort} ${notification.status}`);

  if (platform === 'darwin') {
    return {
      command: 'osascript',
      args: [
        '-e',
        `display notification "${escapeAppleScriptString(text)}" with title "${escapeAppleScriptString(title)}"`,
      ],
    };
  }

  if (platform === 'win32') {
    const psTitle = escapePowerShellSingleQuotedString(title);
    const psText = escapePowerShellSingleQuotedString(text);
    return {
      command: 'powershell',
      args: [
        '-NoProfile',
        '-Command',
        [
          '$ErrorActionPreference = "SilentlyContinue"',
          'if (Get-Module -ListAvailable -Name BurntToast) {',
          `  New-BurntToastNotification -Text @('${psTitle}', '${psText}')`,
          '} else {',
          '  Add-Type -AssemblyName System.Windows.Forms',
          `  [System.Windows.Forms.MessageBox]::Show('${psText}', '${psTitle}') | Out-Null`,
          '}',
        ].join('; '),
      ],
    };
  }

  return {
    command: 'notify-send',
    args: [title, text],
  };
}

export function notifyTerminal(notification: TerminalNotification): void {
  if (!osNotificationsEnabled()) return;

  const command = buildTerminalNotificationCommand(notification);

  try {
    const child = spawn(command.command, [...command.args], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      logger.warn('Failed to fire OS notification for terminal run', {
        runId: notification.runId,
        agentId: notification.agentId,
        status: notification.status,
        err,
      });
    });
    child.unref();
  } catch (err) {
    logger.warn('Failed to fire OS notification for terminal run', {
      runId: notification.runId,
      agentId: notification.agentId,
      status: notification.status,
      err,
    });
  }
}
