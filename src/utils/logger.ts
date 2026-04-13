import chalk from 'chalk';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_ORDER[level] >= LOG_LEVEL_ORDER[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString().slice(11, 23);
}

export const logger = {
  debug(message: string, ...args: unknown[]): void {
    if (!shouldLog('debug')) return;
    console.error(
      chalk.gray(`[${formatTimestamp()}]`),
      chalk.magenta('DEBUG'),
      message,
      ...args,
    );
  },

  info(message: string, ...args: unknown[]): void {
    if (!shouldLog('info')) return;
    console.error(
      chalk.gray(`[${formatTimestamp()}]`),
      chalk.blue('INFO '),
      message,
      ...args,
    );
  },

  warn(message: string, ...args: unknown[]): void {
    if (!shouldLog('warn')) return;
    console.error(
      chalk.gray(`[${formatTimestamp()}]`),
      chalk.yellow('WARN '),
      message,
      ...args,
    );
  },

  error(message: string, ...args: unknown[]): void {
    if (!shouldLog('error')) return;
    console.error(
      chalk.gray(`[${formatTimestamp()}]`),
      chalk.red('ERROR'),
      message,
      ...args,
    );
  },
};
