import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { enableFileLogging, logger, setLogLevel } from '../../src/utils/logger.js';

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
});
