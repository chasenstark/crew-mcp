/**
 * Gated real-binary test for Gemini read-only enforcement via `--policy`.
 *
 * Mock-execa unit tests can only assert that `--policy <path>` is on the argv;
 * they CANNOT prove the real CLI honors the deny (and this repo has been
 * burned by mock tests hiding real CLI-invocation regressions — the `--`
 * prompt-delivery regression and the json-buffering issue both slipped past
 * arg-shape assertions). For a security control that is false confidence, so
 * this file spawns the actual `gemini` binary.
 *
 * It runs only when CREW_GEMINI_LIVE=1 (needs `gemini` + `git` on PATH and a
 * working Gemini auth/quota). Run locally with:
 *   CREW_GEMINI_LIVE=1 npm run test:run -- test/adapters/gemini-cli.readonly.live.test.ts
 *
 * The first test is a CONTROL: it proves an unrestricted gemini actually
 * writes the file in this environment, so the enforcement tests below can't
 * pass vacuously (a regression that silently dropped `--policy` would let the
 * write through and fail the enforcement test, instead of "gemini just never
 * wrote anyway").
 */
import { describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { GeminiCliAdapter } from '../../src/adapters/gemini-cli.js';

const live = process.env.CREW_GEMINI_LIVE === '1';

describe.skipIf(!live)('GeminiCliAdapter read-only policy (real gemini binary)', () => {
  async function makeRepo(): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), 'gemini-live-'));
    await execa('git', ['init'], { cwd: dir });
    await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    await execa('git', ['config', 'user.name', 'test'], { cwd: dir });
    writeFileSync(join(dir, 'README.md'), '# fixture\n');
    await execa('git', ['add', '.'], { cwd: dir });
    await execa('git', ['commit', '-m', 'init'], { cwd: dir });
    return dir;
  }

  it('control: unrestricted gemini DOES write the file (proves the test can detect a write)', async () => {
    const dir = await makeRepo();
    try {
      await execa(
        'gemini',
        [
          '--skip-trust',
          '--approval-mode',
          'yolo',
          '-o',
          'text',
          '-p',
          'Create a file named CONTROL.txt containing "written" using the write_file tool.',
        ],
        { cwd: dir, reject: false },
      );
      expect(existsSync(join(dir, 'CONTROL.txt'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  it('enforced: read-only adapter dispatch CANNOT write a file', async () => {
    const dir = await makeRepo();
    try {
      const adapter = new GeminiCliAdapter();
      const result = await adapter.execute({
        prompt:
          'Create a file named PWNED.txt containing "blocked" using the write_file tool. '
          + 'If you cannot, state exactly why.',
        context: { workingDirectory: dir },
        // trustWorkspace mirrors a crew-controlled path (run-agent sets it for
        // the host repo / crew worktrees) so gemini runs headless in this temp
        // repo; the deny --policy is what must still block the write.
        constraints: { sandbox: 'read-only', trustWorkspace: true },
      });
      expect(existsSync(join(dir, 'PWNED.txt'))).toBe(false);
      // A clean refusal must produce non-empty output under `-o json` + policy
      // (not an empty {response:""} that the captain would surface as silence).
      // This exercises the json+policy combination the unit tests can't.
      expect(result.output.trim().length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  // NOTE: there is intentionally no separate "cannot git commit" live test.
  // Committing goes through run_shell_command, which is denied by the SAME
  // policy file the write test above proves the CLI honors — and the unit test
  // ("renders a deny policy covering exactly the known mutating tools") asserts
  // run_shell_command + save_memory are in that file. A live commit test adds
  // no mechanism coverage and is pathologically slow: when the shell tool is
  // denied, the model flails for minutes instead of returning, so the run hits
  // the test timeout rather than a clean refusal. The write test is the
  // end-to-end proof; the unit test is the per-tool coverage.
});
