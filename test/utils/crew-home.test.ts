import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';

import { resolveCrewHome } from '../../src/utils/crew-home.js';

describe('resolveCrewHome', () => {
  const originalCrewHome = process.env.CREW_HOME;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crew-home-test-'));
  });

  afterEach(() => {
    if (originalCrewHome === undefined) {
      delete process.env.CREW_HOME;
    } else {
      process.env.CREW_HOME = originalCrewHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('honors $CREW_HOME when set', () => {
    const target = join(tmpDir, 'crew-override');
    process.env.CREW_HOME = target;
    const resolved = resolveCrewHome();
    expect(resolved).toBe(target);
    expect(existsSync(target)).toBe(true);
  });

  it('defaults to ~/.crew when $CREW_HOME is unset', () => {
    delete process.env.CREW_HOME;
    const resolved = resolveCrewHome();
    expect(resolved).toBe(join(homedir(), '.crew'));
  });

  it('treats empty $CREW_HOME as unset (defaults to ~/.crew)', () => {
    process.env.CREW_HOME = '';
    const resolved = resolveCrewHome();
    expect(resolved).toBe(join(homedir(), '.crew'));
  });
});
