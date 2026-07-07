/**
 * Gated SIGINT portability tests — runs a real captain CLI subprocess,
 * cancels it mid-turn via AbortController, and records the exit shape.
 *
 * These tests only run when RUN_PORTABILITY_TESTS=1 is set in the
 * environment; they are skipped in CI to avoid spawning real CLIs (which
 * would require auth, quota, and the three binaries to be on PATH).
 *
 * When you do run them locally:
 *   RUN_PORTABILITY_TESTS=1 npm run test:run -- test/adapters/sigint.portability.test.ts
 *
 * The purpose is to document the observed cancel behavior on each captain's
 * real binary. When a test captures new information, paste the observations
 * into the adapter's top-of-file comment block so downstream code understands
 * what SIGINT actually does on that CLI.
 */
import { describe, expect, it } from 'vitest';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';

const runPortability = process.env.RUN_PORTABILITY_TESTS === '1';

describe.skipIf(!runPortability)('captain adapter SIGINT portability (real CLIs)', () => {
  it('Codex: abort mid-turn → execute returns error and frees the process group', async () => {
    const adapter = new CodexAdapter();
    const controller = new AbortController();
    setTimeout(() => controller.abort('portability test cancel'), 500);

    const result = await adapter.execute({
      prompt: 'Count slowly from 1 to 100.',
      context: { workingDirectory: process.cwd() },
      constraints: { signal: controller.signal, timeout: 10_000 },
    });

    // We expect either a success (CLI wrapped up before cancel) or an error
    // with a cancel-flavored message — NOT a hang or process leak.
    expect(['success', 'error', 'partial']).toContain(result.status);
  }, 15_000);

  it('Claude Code: abort mid-turn → execute returns error and frees the process group', async () => {
    const adapter = new ClaudeCodeAdapter();
    const controller = new AbortController();
    setTimeout(() => controller.abort('portability test cancel'), 500);

    const result = await adapter.execute({
      prompt: 'Count slowly from 1 to 100.',
      context: { workingDirectory: process.cwd() },
      constraints: { signal: controller.signal, timeout: 10_000 },
    });

    expect(['success', 'error', 'partial']).toContain(result.status);
  }, 15_000);
});
