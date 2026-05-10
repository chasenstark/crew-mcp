import { constants } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  isCrewWaitOnPath,
  resolveCrewWaitBinary,
} from '../../src/install/crew-binary.js';

describe('resolveCrewWaitBinary', () => {
  it('returns the first executable POSIX crew-wait on PATH', () => {
    const seen: Array<{ candidate: string; mode: number }> = [];
    const result = resolveCrewWaitBinary({
      platform: 'darwin',
      pathEnv: '/one:/two',
      access: (candidate, mode) => {
        seen.push({ candidate, mode });
        if (candidate !== '/two/crew-wait') {
          throw new Error('not executable');
        }
      },
    });

    expect(result).toBe('/two/crew-wait');
    expect(seen).toEqual([
      { candidate: '/one/crew-wait', mode: constants.X_OK },
      { candidate: '/two/crew-wait', mode: constants.X_OK },
    ]);
  });

  it('falls back to a POSIX crew-mcp sibling when direct lookup candidates fail', () => {
    const hits = new Map<string, number>();
    const result = resolveCrewWaitBinary({
      platform: 'linux',
      pathEnv: '/bin',
      access: (candidate) => {
        hits.set(candidate, (hits.get(candidate) ?? 0) + 1);
        if (candidate === '/bin/crew-mcp') return;
        if (candidate === '/bin/crew-wait' && hits.get(candidate) === 2) return;
        throw new Error('not executable');
      },
    });

    expect(result).toBe('/bin/crew-wait');
    expect(hits.get('/bin/crew-wait')).toBe(2);
  });

  it('returns a Windows crew-wait shim found on PATH', () => {
    const result = resolveCrewWaitBinary({
      platform: 'win32',
      pathEnv: 'C:\\Tools;C:\\Bin',
      access: (candidate, mode) => {
        expect(mode).toBe(constants.F_OK);
        if (candidate !== 'C:\\Bin\\crew-wait.cmd') {
          throw new Error('missing');
        }
      },
    });

    expect(result).toBe('C:\\Bin\\crew-wait.cmd');
  });

  it('derives Windows siblings with same extension first, then standard shim order', () => {
    const seen: string[] = [];
    let mcpResolved = false;
    const result = resolveCrewWaitBinary({
      platform: 'win32',
      pathEnv: 'C:\\Bin',
      access: (candidate) => {
        seen.push(candidate);
        if (candidate === 'C:\\Bin\\crew-mcp.exe') {
          mcpResolved = true;
          return;
        }
        if (mcpResolved && candidate === 'C:\\Bin\\crew-wait.ps1') return;
        throw new Error('missing');
      },
    });

    expect(result).toBe('C:\\Bin\\crew-wait.ps1');
    expect(seen).toEqual([
      'C:\\Bin\\crew-wait.cmd',
      'C:\\Bin\\crew-wait.ps1',
      'C:\\Bin\\crew-wait.exe',
      'C:\\Bin\\crew-wait.bat',
      'C:\\Bin\\crew-wait',
      'C:\\Bin\\crew-mcp.cmd',
      'C:\\Bin\\crew-mcp.ps1',
      'C:\\Bin\\crew-mcp.exe',
      'C:\\Bin\\crew-wait.exe',
      'C:\\Bin\\crew-wait.cmd',
      'C:\\Bin\\crew-wait.ps1',
    ]);
  });

  it('tries Windows sibling .cmd/.ps1/.exe/.bat/bare when crew-mcp has no extension', () => {
    const seen: string[] = [];
    const result = resolveCrewWaitBinary({
      platform: 'win32',
      pathEnv: 'C:\\Bin',
      access: (candidate) => {
        seen.push(candidate);
        if (candidate === 'C:\\Bin\\crew-mcp') return;
        if (candidate === 'C:\\Bin\\crew-wait.bat') return;
        throw new Error('missing');
      },
    });

    expect(result).toBe('C:\\Bin\\crew-wait.bat');
    expect(seen.slice(-5)).toEqual([
      'C:\\Bin\\crew-wait.cmd',
      'C:\\Bin\\crew-wait.ps1',
      'C:\\Bin\\crew-wait.exe',
      'C:\\Bin\\crew-wait.bat',
    ]);
  });

  it('throws with install guidance when no candidates pass executable checks', () => {
    expect(() => resolveCrewWaitBinary({
      platform: 'darwin',
      pathEnv: '/bin',
      access: () => {
        throw new Error('missing');
      },
    })).toThrow(/npm install -g crew-mcp/);
  });
});

describe('isCrewWaitOnPath', () => {
  it('only checks direct crew-wait PATH discoverability', () => {
    expect(isCrewWaitOnPath({
      platform: 'darwin',
      pathEnv: '/bin',
      access: (candidate) => {
        if (candidate !== '/bin/crew-mcp') {
          throw new Error('missing');
        }
      },
    })).toBe(false);
  });
});
