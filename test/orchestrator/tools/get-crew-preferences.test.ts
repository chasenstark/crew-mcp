import { mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setConfigValue } from '../../../src/workflow/config-service.js';
import { getCrewPreferencesHandler } from '../../../src/orchestrator/tools/get-crew-preferences.js';
import {
  makeMockAdapter,
  makeRegistry,
} from './panel-test-harness.js';

// getCrewPreferencesHandler loads the EFFECTIVE config, which merges the
// global ~/.crew/workflow.yaml (resolved via os.homedir()). Mock homedir
// to an isolated empty dir so the developer's real global agentDefaults
// don't leak into these assertions.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: vi.fn(actual.homedir) };
});

describe('getCrewPreferencesHandler', () => {
  const mockedHomedir = vi.mocked(homedir);
  let cwd: string;

  beforeEach(() => {
    const root = join(tmpdir(), `crew-preferences-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    cwd = join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    // Isolated home with no ~/.crew/workflow.yaml, so global scope is empty.
    mockedHomedir.mockReturnValue(join(root, 'home'));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    mockedHomedir.mockRestore();
  });

  it('returns an empty result when no agent defaults are configured', async () => {
    const out = await getCrewPreferencesHandler({ scope: 'all' }, {
      projectRoot: cwd,
      registry: makeRegistry([makeMockAdapter({ name: 'codex' })]),
    });

    expect(out).toEqual({});
  });

  it('returns populated iterate and panel preferences', async () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.reviewers', '["claude-code"]');
    setConfigValue(cwd, 'workflow.agentDefaults.panel.reviewers', '["codex","claude-code"]');

    const out = await getCrewPreferencesHandler({ scope: 'all' }, {
      projectRoot: cwd,
      registry: makeRegistry([
        makeMockAdapter({ name: 'codex' }),
        makeMockAdapter({ name: 'claude-code' }),
      ]),
    });

    expect(out).toEqual({
      iterate: {
        implementer: 'codex',
        reviewers: ['claude-code'],
      },
      panel: {
        reviewers: ['codex', 'claude-code'],
      },
      warnings: [],
    });
  });

  it('warns for configured ids absent from list_agents', async () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'missing-agent');

    const out = await getCrewPreferencesHandler({ scope: 'iterate' }, {
      projectRoot: cwd,
      registry: makeRegistry([makeMockAdapter({ name: 'codex' })]),
    });

    expect(out.iterate?.implementer).toBe('missing-agent');
    expect(out.warnings).toEqual([
      "preferred implementer 'missing-agent' is not in list_agents (agent unavailable or uninstalled)",
    ]);
  });

  it('narrows the response to the requested scope', async () => {
    setConfigValue(cwd, 'workflow.agentDefaults.iterate.implementer', 'codex');
    setConfigValue(cwd, 'workflow.agentDefaults.panel.reviewers', '["claude-code"]');

    const out = await getCrewPreferencesHandler({ scope: 'panel' }, {
      projectRoot: cwd,
      registry: makeRegistry([
        makeMockAdapter({ name: 'codex' }),
        makeMockAdapter({ name: 'claude-code' }),
      ]),
    });

    expect(out).toEqual({
      panel: {
        reviewers: ['claude-code'],
      },
      warnings: [],
    });
  });
});
