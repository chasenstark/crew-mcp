import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  syncGeminiSettingsFromCatalog,
  resolveGeminiSettingsPath,
} from '../../../src/cli/runtime/preflight.js';
import { CatalogLock } from '../../../src/captain/catalog-lock.js';
import type { ToolCatalog } from '../../../src/captain/mcp-registration.js';

const baseCatalog: ToolCatalog = {
  mcpServers: [
    { name: 'crew', command: '/bin/crew-mcp', args: ['--namespace', 'mcp__crew__'] },
  ],
};

const driftedCatalog: ToolCatalog = {
  mcpServers: [
    { name: 'crew', command: '/bin/crew-mcp', args: ['--namespace', 'mcp__crew__'] },
    { name: 'extra', command: '/bin/extra' },
  ],
};

describe('syncGeminiSettingsFromCatalog', () => {
  let projectRoot: string;
  let homeOverride: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-preflight-project-'));
    mkdirSync(join(projectRoot, '.crew'), { recursive: true });
    homeOverride = mkdtempSync(join(tmpdir(), 'crew-preflight-home-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
    rmSync(homeOverride, { recursive: true, force: true });
  });

  it('is a no-op for non-gemini captains', () => {
    const result = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'claude-code',
      catalog: baseCatalog,
      homeOverride,
    });
    expect(result.action).toBe('skipped-not-gemini');
    expect(CatalogLock.loadHash(projectRoot)).toBeUndefined();
  });

  it('writes settings.json + lockfile when absent', () => {
    const result = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    expect(result.action).toBe('written');
    const settingsPath = resolveGeminiSettingsPath({ homeOverride }).settingsPath;
    expect(existsSync(settingsPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.mcpServers.crew.command).toBe('/bin/crew-mcp');
    expect(CatalogLock.loadHash(projectRoot)).toBe(result.hash);
  });

  it('is a no-op when lockfile matches and settings.json exists', () => {
    syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    const mtimeBefore = readFileSync(
      resolveGeminiSettingsPath({ homeOverride }).settingsPath,
      'utf-8',
    );
    const second = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    expect(second.action).toBe('skipped-match');
    // settings.json content unchanged
    const mtimeAfter = readFileSync(
      resolveGeminiSettingsPath({ homeOverride }).settingsPath,
      'utf-8',
    );
    expect(mtimeAfter).toBe(mtimeBefore);
  });

  it('regenerates settings.json + lockfile when catalog drifts', () => {
    syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    const first = CatalogLock.loadHash(projectRoot);
    const second = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: driftedCatalog,
      homeOverride,
    });
    expect(second.action).toBe('written');
    expect(second.hash).not.toBe(first);
    expect(CatalogLock.loadHash(projectRoot)).toBe(second.hash);
    const parsed = JSON.parse(
      readFileSync(resolveGeminiSettingsPath({ homeOverride }).settingsPath, 'utf-8'),
    );
    expect(parsed.mcpServers.extra).toBeDefined();
  });

  it('regenerates when settings.json was deleted despite a matching lockfile', () => {
    syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    rmSync(resolveGeminiSettingsPath({ homeOverride }).settingsPath);
    const second = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    expect(second.action).toBe('written');
    expect(existsSync(resolveGeminiSettingsPath({ homeOverride }).settingsPath)).toBe(true);
  });

  it('preserves unrelated keys in an existing settings.json', () => {
    const { dir, settingsPath } = resolveGeminiSettingsPath({ homeOverride });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ ui: { theme: 'dark' } }, null, 2),
      'utf-8',
    );
    syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(parsed.ui).toEqual({ theme: 'dark' });
    expect(parsed.mcpServers.crew).toBeDefined();
  });

  it('partial-write in the lockfile triggers regen on the next call', () => {
    syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    // Corrupt the lockfile to simulate a partial write.
    writeFileSync(
      join(projectRoot, '.crew', 'config.lock.json'),
      'not json',
      'utf-8',
    );
    const second = syncGeminiSettingsFromCatalog({
      projectRoot,
      captainCliName: 'gemini-cli',
      catalog: baseCatalog,
      homeOverride,
    });
    expect(second.action).toBe('written');
  });
});
