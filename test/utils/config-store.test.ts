import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  readConfigFile,
  resolveConfigPath,
  writeConfigFile,
} from '../../src/utils/config-store.js';
import { logger } from '../../src/utils/logger.js';

describe('config-store', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'crew-config-test-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  it('returns defaults when the config file does not exist', () => {
    expect(readConfigFile(home)).toEqual(DEFAULT_CONFIG);
  });

  it('round-trips a written config', () => {
    const config = {
      notifications: { success: false, error: true },
      confirmBeforeMerge: false,
      cleanup: { worktreeTtlDays: 3, runDirTtlDays: 60 },
    };
    writeConfigFile(home, config);
    expect(readConfigFile(home)).toEqual(config);
  });

  it('reads legacy boolean notifications into both channels', () => {
    writeFileSync(
      join(home, CONFIG_FILENAME),
      JSON.stringify({ notifications: false }),
      'utf-8',
    );
    expect(readConfigFile(home)).toEqual({
      notifications: { success: false, error: false },
      confirmBeforeMerge: true,
      cleanup: { worktreeTtlDays: 7, runDirTtlDays: 30 },
    });
  });

  it('parses cleanup TTLs, accepts -1 (off), and drops bad values', () => {
    writeFileSync(
      join(home, CONFIG_FILENAME),
      JSON.stringify({
        cleanup: { worktreeTtlDays: 14, runDirTtlDays: -1 },
      }),
      'utf-8',
    );
    expect(readConfigFile(home).cleanup).toEqual({ worktreeTtlDays: 14, runDirTtlDays: -1 });

    writeFileSync(
      join(home, CONFIG_FILENAME),
      JSON.stringify({ cleanup: { worktreeTtlDays: 'soon', runDirTtlDays: -5 } }),
      'utf-8',
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    // 'soon' (NaN) and -5 (< -1) both drop to defaults.
    expect(readConfigFile(home).cleanup).toEqual({ worktreeTtlDays: 7, runDirTtlDays: 30 });
    expect(warn).toHaveBeenCalled();
  });

  it('first write migrates legacy notification shape in place', () => {
    const path = resolveConfigPath(home);
    writeFileSync(
      path,
      JSON.stringify({ notifications: true, _note: 'legacy' }, null, 2),
      'utf-8',
    );
    writeConfigFile(home, {
      notifications: { success: true, error: false },
      confirmBeforeMerge: true,
      cleanup: { worktreeTtlDays: 7, runDirTtlDays: 30 },
    });
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw._note).toBe('legacy');
    expect(raw.notifications).toEqual({ success: true, error: false });
    expect(raw.confirmBeforeMerge).toBe(true);
  });

  it('preserves underscore-prefixed comments through writes', () => {
    const path = resolveConfigPath(home);
    writeFileSync(
      path,
      JSON.stringify({
        _note: 'hand-edited',
        notifications: { success: true, error: true },
        confirmBeforeMerge: true,
      }, null, 2),
      'utf-8',
    );
    writeConfigFile(home, {
      notifications: { success: false, error: true },
      confirmBeforeMerge: false,
      cleanup: { worktreeTtlDays: 7, runDirTtlDays: 30 },
    });
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw._note).toBe('hand-edited');
    expect(raw.notifications).toEqual({ success: false, error: true });
    expect(raw.confirmBeforeMerge).toBe(false);
  });

  it('seeds a _readme on first write', () => {
    writeConfigFile(home, DEFAULT_CONFIG);
    const raw = JSON.parse(
      readFileSync(resolveConfigPath(home), 'utf-8'),
    ) as Record<string, unknown>;
    expect(Array.isArray(raw._readme)).toBe(true);
  });

  it('falls back to defaults on invalid JSON and logs a warning', () => {
    writeFileSync(join(home, CONFIG_FILENAME), '{ not: json', 'utf-8');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });

  it('drops fields with the wrong type but keeps the rest', () => {
    writeFileSync(
      join(home, CONFIG_FILENAME),
      JSON.stringify({
        notifications: { success: 'yes please', error: false },
        confirmBeforeMerge: 'sure',
      }),
      'utf-8',
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual({
      notifications: { success: true, error: false },
      confirmBeforeMerge: true,
      cleanup: { worktreeTtlDays: 7, runDirTtlDays: 30 },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to defaults for invalid notification container types', () => {
    writeFileSync(
      join(home, CONFIG_FILENAME),
      JSON.stringify({ notifications: 'yes please', confirmBeforeMerge: false }),
      'utf-8',
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual({
      notifications: { success: true, error: true },
      confirmBeforeMerge: false,
      cleanup: { worktreeTtlDays: 7, runDirTtlDays: 30 },
    });
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a non-object root', () => {
    writeFileSync(join(home, CONFIG_FILENAME), JSON.stringify([1, 2, 3]), 'utf-8');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });
});
