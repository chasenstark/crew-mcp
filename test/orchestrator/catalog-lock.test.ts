import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { CatalogLock, CATALOG_LOCK_FILE } from '../../src/orchestrator/catalog-lock.js';

describe('CatalogLock', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-catalog-lock-'));
    mkdirSync(join(root, '.crew'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loadHash returns undefined when no lockfile exists', () => {
    expect(CatalogLock.loadHash(root)).toBeUndefined();
  });

  it('writeHash + loadHash round-trips', () => {
    CatalogLock.writeHash(root, 'deadbeef');
    expect(CatalogLock.loadHash(root)).toBe('deadbeef');
  });

  it('overwriting a hash returns the new value', () => {
    CatalogLock.writeHash(root, 'aaaa');
    CatalogLock.writeHash(root, 'bbbb');
    expect(CatalogLock.loadHash(root)).toBe('bbbb');
  });

  it('malformed lockfile content yields undefined (not a throw)', () => {
    const path = join(root, '.crew', CATALOG_LOCK_FILE);
    writeFileSync(path, 'not json', 'utf-8');
    expect(CatalogLock.loadHash(root)).toBeUndefined();
  });

  it('lockfile with missing catalogHash field yields undefined', () => {
    const path = join(root, '.crew', CATALOG_LOCK_FILE);
    writeFileSync(path, JSON.stringify({ schemaVersion: 1 }), 'utf-8');
    expect(CatalogLock.loadHash(root)).toBeUndefined();
  });

  it('writeHash is atomic (rename, not truncate)', () => {
    CatalogLock.writeHash(root, 'one');
    const path = join(root, '.crew', CATALOG_LOCK_FILE);
    const body = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(body);
    expect(parsed.catalogHash).toBe('one');
    expect(parsed.schemaVersion).toBe(1);
    expect(typeof parsed.updatedAt).toBe('string');
  });
});
