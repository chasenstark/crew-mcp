import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enableFileLogging,
  getLogFilePath,
  logger,
  setLogFilePath,
  setLogLevel,
} from '../../src/utils/logger.js';

describe('logger file logging', () => {
  it('writes log lines to .crew/logs run file', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'orchestra-logger-test-'));

    try {
      const logFile = enableFileLogging(projectRoot);
      setLogLevel('debug');
      logger.info('logger integration test message', { key: 'value' });

      const contents = readFileSync(logFile, 'utf-8');
      expect(logFile).toContain('.crew/logs/run-');
      expect(contents).toContain('INFO');
      expect(contents).toContain('logger integration test message');
      expect(contents).toContain('"key": "value"');
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
      setLogLevel('error');
    }
  });

  it('setLogFilePath pins the log file to an explicit path and appends', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestra-logger-explicit-'));
    // Path includes a nested directory that doesn't exist yet — setLogFilePath
    // must mkdir -p on the parent so callers can pass `/tmp/foo/bar.log`
    // without staging directories themselves.
    const target = join(dir, 'nested', 'crew-mcp.log');

    try {
      expect(existsSync(target)).toBe(false);
      setLogFilePath(target);
      expect(getLogFilePath()).toBe(target);
      setLogLevel('debug');
      logger.info('explicit-path message');
      const contents = readFileSync(target, 'utf-8');
      // Header line records the takeover with the pid.
      expect(contents).toMatch(/INFO Log file opened \(pid=\d+\)/);
      expect(contents).toContain('explicit-path message');

      // Second call to setLogFilePath on the same path appends another
      // header rather than truncating — useful when a host MCP-recycle
      // reopens the same file across restarts.
      const before = contents;
      setLogFilePath(target);
      const after = readFileSync(target, 'utf-8');
      expect(after.startsWith(before)).toBe(true);
      expect(after.length).toBeGreaterThan(before.length);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      setLogLevel('error');
    }
  });
});
