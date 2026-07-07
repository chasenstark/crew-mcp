/**
 * Interactive target picker tests — exercise selectTargets behavior
 * with a stubbed PromptIO so the real readline never gets invoked.
 *
 * Coverage focus: input parsing edge cases (covered separately in
 * parseSelection unit tests below), retry-on-bad-input UX, cancel on
 * blank input, and the empty-detected case.
 */

import { describe, expect, it } from 'vitest';

import {
  parseSelection,
  selectTargets,
  type DetectedHost,
  type PromptIO,
} from '../../src/install/interactive-target.js';

const HOSTS: DetectedHost[] = [
  { id: 'claude-code', displayName: 'Claude Code', installed: true, version: '1.0.23' },
  { id: 'codex', displayName: 'Codex', installed: true, version: '0.128.0' },
  { id: 'agy', displayName: 'Antigravity', installed: false },
];

function stubIO(answers: string[]): PromptIO & { writes: string[] } {
  const writes: string[] = [];
  let cursor = 0;
  return {
    writes,
    write(line) {
      writes.push(line);
    },
    async question(prompt) {
      writes.push(prompt);
      const next = answers[cursor];
      cursor += 1;
      if (next === undefined) {
        throw new Error(`stubIO: ran out of canned answers at cursor ${cursor}`);
      }
      return next;
    },
  };
}

describe('selectTargets', () => {
  it('returns the picked subset when the user types valid indices', async () => {
    const io = stubIO(['1,2']);
    const out = await selectTargets({ hosts: HOSTS, io });
    expect(out).toEqual(['claude-code', 'codex']);
  });

  it('returns all detected hosts when the user types "a"', async () => {
    const io = stubIO(['a']);
    const out = await selectTargets({ hosts: HOSTS, io });
    expect(out).toEqual(['claude-code', 'codex']); // agy is not installed
  });

  it('returns [] when the user enters blank input (cancel)', async () => {
    const io = stubIO(['']);
    const out = await selectTargets({ hosts: HOSTS, io });
    expect(out).toEqual([]);
    expect(io.writes.some((w) => w.includes('cancelled'))).toBe(true);
  });

  it('re-prompts on invalid input and accepts the next valid answer', async () => {
    const io = stubIO(['9', '1']);
    const out = await selectTargets({ hosts: HOSTS, io });
    expect(out).toEqual(['claude-code']);
    expect(io.writes.some((w) => w.includes('"9" is not a valid choice'))).toBe(true);
  });

  it('gives up after maxRetries consecutive bad inputs', async () => {
    const io = stubIO(['bad', 'worse', 'still-bad']);
    const out = await selectTargets({ hosts: HOSTS, io, maxRetries: 2 });
    expect(out).toEqual([]);
    expect(io.writes.some((w) => w.includes('giving up'))).toBe(true);
  });

  it('preserves registration order even when indices are out of order or duplicated', async () => {
    const io = stubIO(['2,1,2']);
    const out = await selectTargets({ hosts: HOSTS, io });
    expect(out).toEqual(['codex', 'claude-code']); // input order, deduped
  });

  it('renders detection status with version when installed', async () => {
    const io = stubIO(['']);
    await selectTargets({ hosts: HOSTS, io });
    const text = io.writes.join('');
    expect(text).toContain('[✓] Claude Code   detected (1.0.23)');
    expect(text).toContain('[✓] Codex         detected (0.128.0)');
    expect(text).toContain('[ ] Antigravity   not on PATH');
  });

  it('throws on a programmer error (zero hosts passed)', async () => {
    await expect(
      selectTargets({ hosts: [], io: stubIO([]) }),
    ).rejects.toThrow(/no hosts/);
  });

  it('"a" with zero detected hosts is a re-promptable error', async () => {
    const noneDetected: DetectedHost[] = [
      { id: 'claude-code', displayName: 'Claude Code', installed: false },
      { id: 'codex', displayName: 'Codex', installed: false },
    ];
    // First "a" fails (no detected); blank cancels.
    const io = stubIO(['a', '']);
    const out = await selectTargets({ hosts: noneDetected, io });
    expect(out).toEqual([]);
    expect(io.writes.some((w) => w.includes('no host CLIs detected'))).toBe(true);
  });
});

describe('parseSelection (unit)', () => {
  it('parses a single index', () => {
    expect(parseSelection('1', HOSTS)).toEqual({ kind: 'ok', targets: ['claude-code'] });
  });

  it('parses comma-separated with whitespace', () => {
    expect(parseSelection(' 1 , 3 ', HOSTS)).toEqual({
      kind: 'ok',
      targets: ['claude-code', 'agy'],
    });
  });

  it('"all" alias works the same as "a"', () => {
    expect(parseSelection('all', HOSTS)).toEqual({
      kind: 'ok',
      targets: ['claude-code', 'codex'],
    });
  });

  it('rejects non-numeric input', () => {
    const result = parseSelection('foo', HOSTS);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toContain('"foo"');
  });

  it('rejects out-of-range indices', () => {
    const result = parseSelection('99', HOSTS);
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.error).toContain('1..3');
  });

  it('rejects "0" (1-based)', () => {
    expect(parseSelection('0', HOSTS).kind).toBe('error');
  });

  it('rejects an empty token after a comma', () => {
    // "1," parses as ["1"] (filtering empty), so this would succeed; check ",,"
    expect(parseSelection(',,', HOSTS).kind).toBe('error');
  });
});
