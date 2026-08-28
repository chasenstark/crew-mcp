import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'tsup';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'pr-watch-waiter-lifetime.ts');
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('crew-pr-watch-wait process lifetime', () => {
  it('stays alive after an active first poll and reaches the second poll', async () => {
    const root = mkdtempSync(join(tmpdir(), 'crew-pr-watch-waiter-process-'));
    roots.push(root);
    const outDir = join(root, 'bundle');
    const crewHome = join(root, 'crew-home');
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'), 'dir');
    await build({
      entry: [FIXTURE],
      outDir,
      format: ['esm'],
      platform: 'node',
      target: 'node20',
      config: false,
      clean: true,
      silent: true,
      splitting: false,
      sourcemap: false,
    });
    const entry = readdirSync(outDir)
      .map((name) => join(outDir, name))
      .find((path) => /pr-watch-waiter-lifetime\.(?:m?js)$/.test(path));
    if (!entry) throw new Error('waiter subprocess bundle was not produced');

    const child = spawn(process.execPath, [entry], {
      cwd: REPO_ROOT,
      env: { ...process.env, CREW_PR_WATCH_TEST_HOME: crewHome },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    const exitCode = await waitForExit(child, 5_000);

    expect(exitCode, stderr).toBe(0);
    expect(stdout).toContain('POLL 1\n');
    expect(stdout).toContain('POLL 2\n');
    expect(stdout.match(/^WAKE terminal$/gm)).toHaveLength(1);
    const resultLine = stdout.split('\n').find((line) => line.startsWith('RESULT '));
    expect(resultLine, stdout).toBeDefined();
    const result = JSON.parse(resultLine!.slice('RESULT '.length)) as {
      readonly watchId: string;
      readonly polls: number;
      readonly wakes: number;
      readonly outcome: string;
    };
    expect(result).toMatchObject({ polls: 2, wakes: 1, outcome: 'terminal' });

    const tracePath = join(crewHome, 'pr-watches', '.meta', 'process-trace.jsonl');
    const trace = readFileSync(tracePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(trace.map((record) => record.event)).toEqual(['start', 'wake', 'exit']);
    expect(trace[1]).toMatchObject({
      watchId: result.watchId,
      status: 'terminal',
      transport: 'codex_queue',
    });
    expect(trace[2]).toMatchObject({ watchId: result.watchId, status: 'terminal' });
  });
});

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<number> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      once(child, 'exit').then(([code]) => typeof code === 'number' ? code : 1),
      new Promise<number>((_resolve, reject) => {
        timeout = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`waiter subprocess exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
