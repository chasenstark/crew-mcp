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
    writeConfigFile(home, { notifications: false });
    expect(readConfigFile(home)).toEqual({ notifications: false });
  });

  it('preserves underscore-prefixed comments through writes', () => {
    const path = resolveConfigPath(home);
    writeFileSync(
      path,
      JSON.stringify({ _note: 'hand-edited', notifications: true }, null, 2),
      'utf-8',
    );
    writeConfigFile(home, { notifications: false });
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    expect(raw._note).toBe('hand-edited');
    expect(raw.notifications).toBe(false);
  });

  it('seeds a _readme on first write', () => {
    writeConfigFile(home, { notifications: true });
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
      JSON.stringify({ notifications: 'yes please' }),
      'utf-8',
    );
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });

  it('rejects a non-object root', () => {
    writeFileSync(join(home, CONFIG_FILENAME), JSON.stringify([1, 2, 3]), 'utf-8');
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    expect(readConfigFile(home)).toEqual(DEFAULT_CONFIG);
    expect(warn).toHaveBeenCalled();
  });
});
