import chalk from 'chalk';
import { appendFileSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const MAX_LOG_ARG_LENGTH = 4_000;

function parseLevel(raw: string | undefined): LogLevel | undefined {
  const level = raw?.toLowerCase();
  if (level === 'debug' || level === 'info' || level === 'warn' || level === 'error') {
    return level;
  }
  return undefined;
}

function resolveInitialConsoleLevel(): LogLevel {
  // Default to 'info' so the lifecycle CLI commands (install / verify /
  // uninstall / status) give the user feedback on success. `crew serve`'s
  // logger output goes to stderr per src/cli/commands/serve.ts; the MCP
  // wire protocol's stdout discipline is unaffected. Set CREW_LOG_LEVEL=
  // error to silence (matches v0.1 default).
  return parseLevel(process.env.CREW_LOG_LEVEL) ?? 'info';
}

function resolveInitialFileLevel(): LogLevel {
  return parseLevel(process.env.CREW_FILE_LOG_LEVEL)
    ?? parseLevel(process.env.CREW_LOG_LEVEL)
    ?? 'debug';
}

let currentLevel: LogLevel = resolveInitialConsoleLevel();
let fileLevel: LogLevel = resolveInitialFileLevel();
let logFilePath: string | null = null;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setFileLogLevel(level: LogLevel): void {
  fileLevel = level;
}

export function getFileLogLevel(): LogLevel {
  return fileLevel;
}

function shouldLogConsole(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

function shouldLogFile(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[fileLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function formatFileTimestamp(): string {
  return new Date().toISOString();
}

function truncate(text: string, maxLength = MAX_LOG_ARG_LENGTH): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}...`;
}

function serializeArg(arg: unknown): string {
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';

  if (typeof arg === 'string') return truncate(arg);
  if (typeof arg === 'number' || typeof arg === 'boolean' || typeof arg === 'bigint') {
    return String(arg);
  }

  if (arg instanceof Error) {
    const stack = arg.stack ? `\n${arg.stack}` : '';
    return truncate(`${arg.name}: ${arg.message}${stack}`);
  }

  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      arg,
      (_key, value) => {
        if (typeof value === 'bigint') return value.toString();
        if (value && typeof value === 'object') {
          if (seen.has(value as object)) return '[Circular]';
          seen.add(value as object);
        }
        return value;
      },
      2,
    );
    if (!json) return String(arg);
    return truncate(json);
  } catch {
    return truncate(String(arg));
  }
}

function appendToLogFile(level: LogLevel, message: string, args: unknown[]): void {
  if (!logFilePath) return;
  if (!shouldLogFile(level)) return;
  try {
    const serializedArgs = args.length > 0
      ? ` ${args.map(serializeArg).join(' ')}`
      : '';
    appendFileSync(logFilePath, `[${formatFileTimestamp()}] ${level.toUpperCase()} ${message}${serializedArgs}\n`);
  } catch {
    // Best-effort; never crash logging.
  }
}

function log(level: LogLevel, colorizedLevel: string, message: string, args: unknown[]): void {
  appendToLogFile(level, message, args);
  if (!shouldLogConsole(level)) return;
  console.error(
    chalk.gray(`[${formatTimestamp()}]`),
    colorizedLevel,
    message,
    ...args,
  );
}

export function enableFileLogging(projectRoot: string): string {
  const logsDir = join(projectRoot, '.crew', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(logsDir, `run-${timestamp}.log`);
  writeFileSync(path, `[${formatFileTimestamp()}] INFO Log file created\n`);
  logFilePath = path;
  return path;
}

export function getLogFilePath(): string | null {
  return logFilePath;
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    log('debug', chalk.magenta('DEBUG'), message, args);
  },

  info(message: string, ...args: unknown[]): void {
    log('info', chalk.blue('INFO '), message, args);
  },

  warn(message: string, ...args: unknown[]): void {
    log('warn', chalk.yellow('WARN '), message, args);
  },

  error(message: string, ...args: unknown[]): void {
    log('error', chalk.red('ERROR'), message, args);
  },
};
