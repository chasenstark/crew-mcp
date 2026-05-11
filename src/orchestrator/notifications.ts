import { spawn } from 'node:child_process';

import { readConfigFile } from '../utils/config-store.js';
import { resolveCrewHome } from '../utils/crew-home.js';
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

export function osNotificationsEnabled(
  status: TerminalNotification['status'],
): boolean {
  // Env var is an override (escape hatch for CI/one-shot runs). When
  // explicitly set to "off" we honor it without touching the config
  // file. Otherwise the persistent config decides (default: enabled).
  if (process.env.CREW_OS_NOTIFICATIONS === 'off') return false;
  if (status === 'cancelled') return false;
  try {
    const notifications = readConfigFile(resolveCrewHome()).notifications;
    return status === 'success' ? notifications.success : notifications.error;
  } catch (err) {
    // Fail closed: if the config store throws (permission denied,
    // disk full, unexpected fs state) we cannot tell whether the
    // user has disabled notifications. Defaulting to *on* could
    // resurrect toasts the user explicitly turned off — worse UX
    // than briefly missing them while the underlying issue is fixed.
    logger.warn('osNotificationsEnabled: config-store read failed; defaulting to off', { err });
    return false;
  }
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
  // Include the full run_id so users with multiple in-flight runs can
  // unambiguously match the notification to the run. The 8-char prefix
  // collides too easily across a busy crew home (we hit several
  // collisions during plan dogfood), and the full UUID still fits on
  // one line for every platform's notification surface.
  const title = oneLine(`crew: ${notification.agentId}`);
  const text = oneLine(`run ${notification.runId} ${notification.status}`);

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
  if (!osNotificationsEnabled(notification.status)) return;

  const command = buildTerminalNotificationCommand(notification);
  const logContext = {
    runId: notification.runId,
    agentId: notification.agentId,
    status: notification.status,
    command: command.command,
  };

  try {
    const child = spawn(command.command, [...command.args], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      logger.warn('Failed to fire OS notification for terminal run', { ...logContext, err });
    });
    // Real-world failures (Linux DBus down, no DISPLAY, BurntToast
    // module missing, osascript permission denied) often surface as
    // non-zero exit codes AFTER spawn succeeds — the 'error' listener
    // doesn't catch those. Log them so a silently-broken notification
    // pipeline is at least observable in the server log.
    child.on('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        logger.warn('OS notification command exited non-zero', {
          ...logContext,
          exitCode: code,
        });
      } else if (signal !== null) {
        logger.warn('OS notification command terminated by signal', {
          ...logContext,
          signal,
        });
      }
    });
    child.unref();
  } catch (err) {
    logger.warn('Failed to fire OS notification for terminal run', { ...logContext, err });
  }
}
