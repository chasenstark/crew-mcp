/**
 * Tests for the gitignore guard. Verifies the heuristic for "is
 * .crew already ignored?" and that writes are correct + idempotent.
 *
 * Surfaced by Finding 7 in docs/status/v0.2-smoke-2026-05-04.md.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  alreadyCoversCrew,
  ensureCrewIgnored,
} from '../../src/git/gitignore-guard.js';

describe('alreadyCoversCrew', () => {
  it('returns false on empty content', () => {
    expect(alreadyCoversCrew('')).toBe(false);
  });

  it('returns false when only unrelated rules exist', () => {
    expect(alreadyCoversCrew('node_modules\ndist\n')).toBe(false);
  });

  it('matches `.crew`', () => {
    expect(alreadyCoversCrew('.crew\n')).toBe(true);
  });

  it('matches `.crew/`', () => {
    expect(alreadyCoversCrew('.crew/\n')).toBe(true);
  });

  it('matches `/.crew/`', () => {
    expect(alreadyCoversCrew('/.crew/\n')).toBe(true);
  });

  it('matches a broader rule like `.crew/runs/`', () => {
    expect(alreadyCoversCrew('.crew/runs/\n')).toBe(true);
  });

  it('ignores comment lines', () => {
    expect(alreadyCoversCrew('# .crew\n')).toBe(false);
  });

  it('ignores negated rules (!) so the user can opt-in to tracking', () => {
    expect(alreadyCoversCrew('!.crew\n')).toBe(false);
  });

  it('tolerates leading/trailing whitespace on a covering rule', () => {
    expect(alreadyCoversCrew('  .crew/  \n')).toBe(true);
  });
});

describe('ensureCrewIgnored', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crew-gitignore-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('creates a .gitignore with the rule when none exists', () => {
    expect(existsSync(join(root, '.gitignore'))).toBe(false);
    const result = ensureCrewIgnored(root);
    expect(result.added).toBe(true);
    expect(result.gitignorePath).toBe(join(root, '.gitignore'));
    const written = readFileSync(result.gitignorePath, 'utf-8');
    expect(written).toContain('.crew/');
    expect(written).toContain('crew-mcp');
  });

  it('appends the rule to an existing .gitignore that doesn\'t cover .crew', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules\ndist\n', 'utf-8');
    const result = ensureCrewIgnored(root);
    expect(result.added).toBe(true);
    const written = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(written.startsWith('node_modules\ndist\n')).toBe(true);
    expect(written).toContain('.crew/');
  });

  it('is a no-op when .crew/ is already covered', () => {
    const before = 'node_modules\n.crew/\n';
    writeFileSync(join(root, '.gitignore'), before, 'utf-8');
    const result = ensureCrewIgnored(root);
    expect(result.added).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe(before);
  });

  it('is a no-op when a broader rule like .crew/runs/ is present', () => {
    const before = '.crew/runs/\n';
    writeFileSync(join(root, '.gitignore'), before, 'utf-8');
    const result = ensureCrewIgnored(root);
    expect(result.added).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe(before);
  });

  it('is idempotent when called twice', () => {
    ensureCrewIgnored(root);
    const afterFirst = readFileSync(join(root, '.gitignore'), 'utf-8');
    const second = ensureCrewIgnored(root);
    expect(second.added).toBe(false);
    expect(readFileSync(join(root, '.gitignore'), 'utf-8')).toBe(afterFirst);
  });

  it('preserves missing trailing newline by inserting one before appending', () => {
    writeFileSync(join(root, '.gitignore'), 'node_modules', 'utf-8'); // no trailing \n
    ensureCrewIgnored(root);
    const written = readFileSync(join(root, '.gitignore'), 'utf-8');
    expect(written.startsWith('node_modules\n')).toBe(true);
    expect(written).toContain('.crew/');
  });
});
