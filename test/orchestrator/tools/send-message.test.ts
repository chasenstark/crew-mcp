import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  deleteRunAuthSidecar,
  issueRunAuthSidecar,
  revokeRunAuthSidecar,
} from '../../../src/orchestrator/auth/index.js';
import { listMessages } from '../../../src/orchestrator/captain-inbox/store.js';
import {
  sendMessageInputSchema,
  sendMessageToolHandler,
} from '../../../src/orchestrator/tools/send-message.js';

function tempRoot(): { readonly crewHome: string; readonly repoRoot: string; readonly cleanup: () => void } {
  const crewHome = mkdtempSync(join(tmpdir(), 'crew-send-home-'));
  const repoRoot = mkdtempSync(join(tmpdir(), 'crew-send-repo-'));
  return {
    crewHome,
    repoRoot,
    cleanup: () => {
      rmSync(crewHome, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    },
  };
}

describe('send_message worker tool', () => {
  it('validates input kind defaults, caps, to variants, and body requirement', () => {
    expect(sendMessageInputSchema.parse({ body: 'hello' })).toMatchObject({
      body: 'hello',
      kind: 'note',
      to: { kind: 'captain' },
    });
    expect(sendMessageInputSchema.safeParse({ body: 'hello', kind: 'review' }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ body: 'hello', to: { kind: 'captain' } }).success).toBe(true);
    expect(sendMessageInputSchema.safeParse({ body: 'hello', to: { kind: 'run' } }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({}).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({
      body: 'hello',
      files: Array.from({ length: 21 }, (_, index) => `f-${index}`),
    }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({
      body: 'hello',
      excerpts: Array.from({ length: 9 }, () => ({ file: 'x', range: [1, 1], text: 'x' })),
    }).success).toBe(false);
    expect(sendMessageInputSchema.safeParse({
      body: 'hello',
      excerpts: [{ file: 'x', range: [50, 3], text: 'bad range' }],
    }).success).toBe(false);
  });

  it('stamps identity from the sidecar and ignores spoofed input', async () => {
    const h = tempRoot();
    try {
      const issued = await issueRunAuthSidecar({
        crewHome: h.crewHome,
        runId: 'worker-run',
        agentId: 'codex',
        repoRoot: h.repoRoot,
        captainServeInstance: 'captain-test',
        writeMode: 'must-not-exist',
      });

      const result = await sendMessageToolHandler(
        {
          body: 'done',
          kind: 'status',
          to: { kind: 'captain' },
          from: { kind: 'run', run_id: 'spoof', agent_id: 'spoof' },
          repo_root_at_send: '/spoof',
        } as never,
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: issued.sidecar.token } as NodeJS.ProcessEnv,
        },
      );

      expect(result.isError).not.toBe(true);
      const [stored] = listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot });
      expect(stored.from).toEqual({ kind: 'run', run_id: 'worker-run', agent_id: 'codex' });
      expect(stored.worker_run_id_at_send).toBe('worker-run');
      expect(stored.worker_agent_id_at_send).toBe('codex');
      expect(stored.repo_root_at_send).toBe(h.repoRoot);
    } finally {
      h.cleanup();
    }
  });

  it('revalidates revoked, deleted, and changed-token sidecars per call', async () => {
    const h = tempRoot();
    try {
      const issued = await issueRunAuthSidecar({
        crewHome: h.crewHome,
        runId: 'worker-run',
        agentId: 'codex',
        repoRoot: h.repoRoot,
        captainServeInstance: 'captain-test',
        writeMode: 'must-not-exist',
      });

      let result = await sendMessageToolHandler(
        { body: 'wrong token', kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: 'f'.repeat(64) } as NodeJS.ProcessEnv,
        },
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: 'token_invalid' });

      await revokeRunAuthSidecar(h.crewHome, 'worker-run');
      result = await sendMessageToolHandler(
        { body: 'revoked', kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: issued.sidecar.token } as NodeJS.ProcessEnv,
        },
      );
      expect(result.structuredContent).toEqual({ error: 'token_revoked' });

      result = await sendMessageToolHandler(
        { body: 'revoked wrong token', kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: 'f'.repeat(64) } as NodeJS.ProcessEnv,
        },
      );
      expect(result.structuredContent).toEqual({ error: 'token_invalid' });

      deleteRunAuthSidecar(h.crewHome, 'worker-run');
      result = await sendMessageToolHandler(
        { body: 'deleted', kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: issued.sidecar.token } as NodeJS.ProcessEnv,
        },
      );
      expect(result.structuredContent).toEqual({ error: 'run_not_active' });
    } finally {
      h.cleanup();
    }
  });

  it('reports repo_root_mismatch when the sidecar repo is gone', async () => {
    const h = tempRoot();
    try {
      const issued = await issueRunAuthSidecar({
        crewHome: h.crewHome,
        runId: 'worker-run',
        agentId: 'codex',
        repoRoot: h.repoRoot,
        captainServeInstance: 'captain-test',
        writeMode: 'must-not-exist',
      });
      rmSync(h.repoRoot, { recursive: true, force: true });

      const result = await sendMessageToolHandler(
        { body: 'repo gone', kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: issued.sidecar.token } as NodeJS.ProcessEnv,
        },
      );

      expect(result.structuredContent).toEqual({ error: 'repo_root_mismatch' });
    } finally {
      h.cleanup();
    }
  });

  it('truncates over-cap bodies with metadata and a warning', async () => {
    const h = tempRoot();
    try {
      const issued = await issueRunAuthSidecar({
        crewHome: h.crewHome,
        runId: 'worker-run',
        agentId: 'codex',
        repoRoot: h.repoRoot,
        captainServeInstance: 'captain-test',
        writeMode: 'must-not-exist',
      });
      const body = 'x'.repeat(16 * 1024 + 1);

      const result = await sendMessageToolHandler(
        { body, kind: 'note', to: { kind: 'captain' } },
        {
          crewHome: h.crewHome,
          workerAuth: issued.sidecar,
          env: { CREW_RUN_TOKEN: issued.sidecar.token } as NodeJS.ProcessEnv,
        },
      );

      expect(result.isError).not.toBe(true);
      expect((result.structuredContent as { warnings: string[] }).warnings[0]).toContain('body_truncated');
      const [stored] = listMessages({ crewHome: h.crewHome, repoRoot: h.repoRoot });
      expect(stored.body).toContain('[... truncated; original was 16385 chars]');
      expect(stored.body.length).toBe(16 * 1024);
      expect(stored.body_truncated).toEqual({ original_length: 16 * 1024 + 1 });
    } finally {
      try {
        chmodSync(h.repoRoot, 0o700);
      } catch {
        // Repo may already be gone in failure paths.
      }
      h.cleanup();
    }
  });

  it('requires restricted worker mode', async () => {
    const h = tempRoot();
    try {
      const result = await sendMessageToolHandler(
        { body: 'captain path', kind: 'note', to: { kind: 'captain' } },
        { crewHome: h.crewHome },
      );
      expect(result.structuredContent).toEqual({ error: 'worker_mode_required' });
    } finally {
      h.cleanup();
    }
  });
});
