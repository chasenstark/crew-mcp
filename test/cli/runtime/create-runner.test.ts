import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createRunner } from '../../../src/cli/runtime/create-runner.js';
import { JudgmentRunner } from '../../../src/captain/judgment-runner.js';
import { CaptainSession } from '../../../src/captain/session.js';
import {
  __resetCaptainPresetWarnLatchForTest,
  __resetPreflightWarningLatchForTest,
} from '../../../src/cli/runtime/preflight.js';
import { __resetPresetWarnLatchForTest } from '../../../src/captain/preset-resolver.js';
import { logger } from '../../../src/utils/logger.js';

function writeProjectWorkflow(projectRoot: string, yaml: string): void {
  const crewDir = join(projectRoot, '.crew');
  mkdirSync(crewDir, { recursive: true });
  writeFileSync(join(crewDir, 'workflow.yaml'), yaml, 'utf-8');
}

describe('createRunner', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = join(tmpdir(), `captain-create-runner-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(projectRoot, { recursive: true });
    __resetPreflightWarningLatchForTest();
    __resetCaptainPresetWarnLatchForTest();
    __resetPresetWarnLatchForTest();
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('creates a JudgmentRunner', () => {
    const { runner } = createRunner(projectRoot);
    expect(runner).toBeInstanceOf(JudgmentRunner);
  });

  it('always hydrates a CaptainSession + ToolDispatcher', () => {
    const { session, dispatcher } = createRunner(projectRoot);
    expect(session).toBeDefined();
    expect(dispatcher).toBeDefined();
  });

  it('passes session + dispatcher into JudgmentRunner', () => {
    const { runner, session, dispatcher } = createRunner(projectRoot);
    expect(runner).toBeInstanceOf(JudgmentRunner);
    expect((runner as JudgmentRunner).getSession()).toBe(session);
    expect((runner as JudgmentRunner).getDispatcher()).toBe(dispatcher);
  });

  it('loads an existing session from disk if one is persisted', () => {
    // Prime a session.json so createRunner sees it as existing.
    const s = CaptainSession.create({ projectRoot });
    s.appendUserMessage('from prior run', '2026-04-19T00:00:00.000Z');
    s.persist();
    const { session } = createRunner(projectRoot);
    expect(session.getMessages().length).toBeGreaterThan(0);
  });

  it('clears an incompatible captain.model scalar before the runner captures it', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      writeProjectWorkflow(
        projectRoot,
        [
          'workflow:',
          '  name: test',
          '  execution:',
          '    mode: judgment',
          '  steps: []',
          '  completion:',
          '    strategy: judge_approval',
          '    fallback: max_passes',
          'agents:',
          '  codex:',
          '    adapter: codex',
          'captain:',
          '  cli: codex',
          '  model: claude-sonnet-4-7',
          'error_handling:',
          '  default:',
          '    retry: 1',
          '    fallback: null',
          '    on_exhausted: ask_user',
          '',
        ].join('\n'),
      );

      const { runner, config } = createRunner(projectRoot);

      // Config mutated in-place: the mismatched scalar is gone.
      expect(config.captain.model).toBeUndefined();
      // Warn fired exactly once.
      const modelWarns = warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === 'string' && msg.includes('captain.model'),
      );
      expect(modelWarns).toHaveLength(1);
      // The runner inherited the resolved (undefined) model, not the stale scalar.
      const captured = (runner as unknown as { captainModel?: string }).captainModel;
      expect(captured).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('clears only the mismatched map entry and hands the runner undefined', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      writeProjectWorkflow(
        projectRoot,
        [
          'workflow:',
          '  name: test',
          '  execution:',
          '    mode: judgment',
          '  steps: []',
          '  completion:',
          '    strategy: judge_approval',
          '    fallback: max_passes',
          'agents:',
          '  codex:',
          '    adapter: codex',
          '  claude-code:',
          '    adapter: claude-code',
          'captain:',
          '  cli: codex',
          '  model:',
          '    claude-code: CLAUDE_SONNET',
          '    codex: CLAUDE_SONNET',
          'error_handling:',
          '  default:',
          '    retry: 1',
          '    fallback: null',
          '    on_exhausted: ask_user',
          '',
        ].join('\n'),
      );

      const { runner, config } = createRunner(projectRoot);

      const map = config.captain.model as Record<string, string>;
      expect(map.codex).toBeUndefined();
      expect(map['claude-code']).toBe('claude-sonnet-4-7');

      const captured = (runner as unknown as { captainModel?: string }).captainModel;
      expect(captured).toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }
  });

  describe('M5-1 preset hydration', () => {
    it('threads config.presets + captain.preset through to the runner (default preset hint reaches system prompt)', async () => {
      writeProjectWorkflow(
        projectRoot,
        [
          'workflow:',
          '  name: test',
          '  execution:',
          '    mode: judgment',
          '  steps: []',
          '  completion:',
          '    strategy: judge_approval',
          '    fallback: max_passes',
          'agents:',
          '  claude-code:',
          '    adapter: claude-code',
          'captain:',
          '  cli: claude-code',
          '  preset: default',
          'presets:',
          '  default:',
          '    description: the default',
          '    hint: the verbatim default hint line',
          'error_handling:',
          '  default:',
          '    retry: 1',
          '    fallback: null',
          '    on_exhausted: ask_user',
          '',
        ].join('\n'),
      );

      const { runner, config } = createRunner(projectRoot);
      expect(config.captain.preset).toBe('default');
      expect(config.presets?.default?.hint).toBe('the verbatim default hint line');

      // Inspect the runner-stored fields (narrow shape: presets +
      // defaultPresetName — M5-6 keeps resolution per-turn, not construction).
      const r = runner as unknown as {
        presets?: Record<string, unknown>;
        defaultPresetName?: string;
      };
      expect(r.defaultPresetName).toBe('default');
      expect(r.presets?.default).toBeDefined();

      // Render the prompt through the same path the captain-turn uses and
      // confirm the default hint body is present.
      const { buildCaptainSystemPrompt } = await import(
        '../../../src/captain/prompts/captain-system.js'
      );
      const { resolveActivePreset } = await import(
        '../../../src/captain/preset-resolver.js'
      );
      const resolved = resolveActivePreset({
        presets: config.presets,
        defaultPresetName: config.captain.preset,
      });
      const prompt = buildCaptainSystemPrompt({
        workflow: config.workflow,
        agents: [{ name: 'codex', capabilities: ['implement'] }],
        preset: resolved?.preset,
        tools: [{ name: 'run_agent', description: 'x' }],
      });
      expect(prompt).toContain('## Preset hint');
      expect(prompt).toContain('the verbatim default hint line');
    });

    it('preflight warns when captain.preset points at an unknown name', () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      try {
        writeProjectWorkflow(
          projectRoot,
          [
            'workflow:',
            '  name: test',
            '  execution:',
            '    mode: judgment',
            '  steps: []',
            '  completion:',
            '    strategy: judge_approval',
            '    fallback: max_passes',
            'agents:',
            '  claude-code:',
            '    adapter: claude-code',
            'captain:',
            '  cli: claude-code',
            '  preset: nonexistent',
            'presets:',
            '  known:',
            '    hint: hi',
            'error_handling:',
            '  default:',
            '    retry: 1',
            '    fallback: null',
            '    on_exhausted: ask_user',
            '',
          ].join('\n'),
        );

        createRunner(projectRoot);
        const presetWarns = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === 'string' && msg.includes('captain.preset'),
        );
        expect(presetWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });
});
