/**
 * M3 tool-surface integration tests. Exercises the captain-turn +
 * scheduler pair (buildM3SessionLoopPair) routing the 8 mcp__crew__
 * tools. Post-M4-5 this is the authoritative coverage for
 * JudgmentRunner's production path — the legacy 11-verb surface and
 * its migration-coverage tests are gone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';
import { z } from 'zod';
import { JudgmentRunner } from '../../src/captain/judgment-runner.js';
import { StateStore } from '../../src/state/store.js';
import { WorktreeManager } from '../../src/git/worktree.js';
import { CaptainSession } from '../../src/captain/session.js';
import { ToolDispatcher } from '../../src/captain/tool-dispatcher.js';
import type { AgentAdapter, ToolCall, ToolLoopResult, ToolDefinition, ToolLoopMessage, ToolResult } from '../../src/adapters/types.js';
import type { WorkflowConfig } from '../../src/workflow/types.js';
import type { AgentRegistry } from '../../src/captain/events.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

function makeCaptain(
  handler: (
    tools: ToolDefinition[],
    messages: ToolLoopMessage[],
    onToolCall: (call: ToolCall) => Promise<ToolResult>,
  ) => Promise<ToolLoopResult>,
): AgentAdapter {
  return {
    name: 'fake-captain',
    capabilities: ['analyze'],
    supportsJsonSchema: true,
    captainCapabilities: {
      supportsToolLoop: true,
      supportsStructuredDecisions: true,
      supportsPauseForUserInput: true,
    },
    execute: async () => ({
      output: '',
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    executeWithSchema: async <T extends z.ZodType>(_prompt: string, _schema: T) => {
      throw new Error('not used');
    },
    executeWithTools: async (tools, messages, onToolCall) => handler(tools, messages, onToolCall),
    healthCheck: async () => ({ available: true, authenticated: true }),
  };
}

function makeRegistry(agents: AgentAdapter[]): AgentRegistry {
  const map = new Map(agents.map((a) => [a.name, a]));
  return {
    get: (name) => map.get(name),
    list: () =>
      Array.from(map.values()).map((a) => ({
        name: a.name,
        capabilities: [...a.capabilities] as string[],
      })),
  };
}

function makeSubagent(name: string): AgentAdapter {
  return {
    name,
    capabilities: ['implement'],
    supportsJsonSchema: false,
    execute: async () => ({
      output: `ran ${name}`,
      filesModified: [],
      status: 'success',
      metadata: {},
    }),
    healthCheck: async () => ({ available: true, authenticated: true }),
  };
}

describe('JudgmentRunner M3 tool surface', () => {
  let projectRoot: string;
  let stateStore: StateStore;
  let worktreeManager: WorktreeManager;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'crew-m3-scaffold-'));
    execSync('git init -q', { cwd: projectRoot });
    execSync('git config user.email test@crew.local', { cwd: projectRoot });
    execSync('git config user.name test', { cwd: projectRoot });
    writeFileSync(join(projectRoot, '.gitignore'), '.crew/\n', 'utf-8');
    execSync('git add .gitignore', { cwd: projectRoot });
    execSync('git commit -q -m init', { cwd: projectRoot });
    stateStore = new StateStore(projectRoot);
    worktreeManager = new WorktreeManager(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('constructs with session + dispatcher injected and exposes them via getters', () => {
    const captain = makeCaptain(async () => ({ status: 'completed', transcript: [] }));
    const session = CaptainSession.create({ projectRoot });
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );
    expect(runner.getSession()).toBe(session);
    expect(runner.getDispatcher()).toBe(dispatcher);
  });

  it('captain turn receives exactly 8 mcp__crew__ tools', async () => {
    let toolsSeen: ToolDefinition[] | undefined;
    const captain = makeCaptain(async (tools, _msgs, onToolCall) => {
      toolsSeen = tools;
      // Finish immediately so the loop terminates.
      await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'nothing to do' },
      });
      return { status: 'completed', transcript: [] };
    });
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('hello');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );
    await runner.run('hello');
    expect(toolsSeen).toBeDefined();
    expect(toolsSeen!.length).toBe(8);
    const names = toolsSeen!.map((t) => t.name).sort();
    expect(names).toEqual([
      'mcp__crew__analyze_output',
      'mcp__crew__ask_user',
      'mcp__crew__compress_context',
      'mcp__crew__finish',
      'mcp__crew__list_agents',
      'mcp__crew__message_user',
      'mcp__crew__plan_tasks',
      'mcp__crew__run_agent',
    ]);
  });

  it('routes a run_agent tool call through the dispatcher', async () => {
    let toolOutput: unknown;
    let turn = 0;
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      turn++;
      if (turn === 1) {
        const result = await onToolCall({
          name: 'mcp__crew__run_agent',
          input: { agent_id: 'codex', prompt: 'fix a typo' },
        });
        toolOutput = result.output;
        return { status: 'completed', transcript: [] };
      }
      // On the second turn (after run_agent completes), finish.
      await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'fix complete' },
      });
      return { status: 'completed', transcript: [] };
    });
    const codex = makeSubagent('codex');
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('fix');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain, codex]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );
    const report = await runner.run('fix');
    expect(report).toBe('fix complete');
    expect(toolOutput).toMatchObject({ status: 'dispatched' });
    // The session should now have a tool_call record for run_agent.
    const toolCallMessage = session.getMessages().find(
      (m) => m.role === 'tool_call' && m.toolName === 'run_agent',
    );
    expect(toolCallMessage).toBeDefined();
    // And a tool_result for run_agent from the dispatcher's run:complete
    // event — proving the dispatcher path completed end-to-end.
    const toolResult = session.getMessages().find(
      (m) => m.role === 'tool_result' && m.toolCallId === toolCallMessage!.toolCallId,
    );
    expect(toolResult).toBeDefined();
  });

  it('merges successful run_agent worktree changes before finishing', async () => {
    let turn = 0;
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      turn++;
      if (turn === 1) {
        await onToolCall({
          name: 'mcp__crew__run_agent',
          input: { agent_id: 'codex', prompt: 'create generated file' },
        });
        return { status: 'completed', transcript: [] };
      }
      await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'generated file complete' },
      });
      return { status: 'completed', transcript: [] };
    });
    const codex: AgentAdapter = {
      ...makeSubagent('codex'),
      execute: async (task) => {
        const srcDir = join(task.context.workingDirectory, 'src');
        mkdirSync(srcDir, { recursive: true });
        writeFileSync(join(srcDir, 'generated.ts'), 'export const generated = true;\n', 'utf-8');
        return {
          output: 'created generated file',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    };
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('generate');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain, codex]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    const report = await runner.run('generate');

    expect(report).toBe('generated file complete');
    expect(readFileSync(join(projectRoot, 'src', 'generated.ts'), 'utf-8'))
      .toBe('export const generated = true;\n');
    const toolResult = session.getMessages().find(
      (m) => m.role === 'tool_result' && m.status === 'success',
    );
    expect(toolResult?.output).toMatchObject({
      filesModified: ['src/generated.ts'],
      status: 'success',
    });
  });

  it('finish tool ends the loop with the summary as finalReport', async () => {
    let finishResult: ToolResult | undefined;
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      await onToolCall({
        name: 'mcp__crew__message_user',
        input: { text: 'this is a quick answer' },
      });
      finishResult = await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'done!' },
      });
      return { status: 'completed', transcript: [] };
    });
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('what is this?');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );
    const report = await runner.run('what is this?');
    expect(report).toBe('done!');
    // message_user message is in the log.
    expect(
      session.getMessages().some(
        (m) => m.role === 'assistant' && m.text === 'this is a quick answer',
      ),
    ).toBe(true);
    // finish wrote the summary as assistant text.
    expect(
      session.getMessages().some((m) => m.role === 'assistant' && m.text === 'done!'),
    ).toBe(true);
    expect(finishResult).toMatchObject({ terminal: true, terminalOutput: 'done!' });
  });

  it('routes multiple run_agent calls without gating via legacy budgets, then finishes after results', async () => {
    // Post-M4-5 behavioral invariant: the M3 path goes directly through
    // handleM3ToolCallFromAdapter. Legacy 11-verb budgets
    // (maxDeterministicFallbacks, etc.) are gone — each tool's zod schema
    // is the only gate.
    let turn = 0;
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      turn++;
      if (turn === 1) {
        // Call run_agent multiple times in a single adapter turn.
        for (let i = 0; i < 3; i++) {
          await onToolCall({
            name: 'mcp__crew__run_agent',
            input: { agent_id: 'codex', prompt: `task ${i + 1}` },
          });
        }
        return { status: 'completed', transcript: [] };
      }
      await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'all queued' },
      });
      return { status: 'completed', transcript: [] };
    });
    const codex = makeSubagent('codex');
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('triple');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain, codex]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );
    const report = await runner.run('triple');
    expect(report).toBe('all queued');
    // Three run_agent tool_calls were recorded, all dispatched.
    const runAgentCalls = session.getMessages().filter(
      (m) => m.role === 'tool_call' && m.toolName === 'run_agent',
    );
    expect(runAgentCalls).toHaveLength(3);
  });

  it('blocks finish in the same turn as a dispatched tool and allows it after the result', async () => {
    let releaseSubagent!: () => void;
    const subagentDone = new Promise<void>((resolve) => {
      releaseSubagent = resolve;
    });
    let finishBeforeResult: ToolResult | undefined;
    let turn = 0;
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      turn++;
      if (turn === 1) {
        await onToolCall({
          name: 'mcp__crew__run_agent',
          input: { agent_id: 'codex', prompt: 'slow task' },
        });
        finishBeforeResult = await onToolCall({
          name: 'mcp__crew__finish',
          input: { summary: 'too early' },
        });
        return { status: 'completed', transcript: [] };
      }
      await onToolCall({
        name: 'mcp__crew__finish',
        input: { summary: 'finished after result' },
      });
      return { status: 'completed', transcript: [] };
    });
    const codex: AgentAdapter = {
      ...makeSubagent('codex'),
      execute: async () => {
        await subagentDone;
        return {
          output: 'slow task complete',
          filesModified: [],
          status: 'success',
          metadata: {},
        };
      },
    };
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('slow');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain, codex]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    const run = runner.run('slow');
    await new Promise((r) => setTimeout(r, 20));
    expect(finishBeforeResult?.output).toMatchObject({ status: 'blocked' });
    expect(
      session.getMessages().some((m) => m.role === 'assistant' && m.text === 'too early'),
    ).toBe(false);

    releaseSubagent();
    await expect(run).resolves.toBe('finished after result');
    expect(turn).toBe(2);
  });

  it('fails the workflow when the captain adapter returns a non-replay failure', async () => {
    const captain = makeCaptain(async () => ({
      status: 'failed',
      transcript: [],
      error: 'decision subprocess exited 1',
    }));
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('trigger failure');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    await expect(runner.run('trigger failure')).rejects.toThrow(
      'Captain adapter failed: decision subprocess exited 1',
    );
    expect(stateStore.loadState()?.status).toBe('failed');
    expect(
      session.getMessages().some((m) => m.role === 'assistant' && m.text.includes('Workflow Report')),
    ).toBe(false);
  });

  it('persists synchronous tool side effects before surfacing a captain failure', async () => {
    const captain = makeCaptain(async (_tools, _msgs, onToolCall) => {
      await onToolCall({
        name: 'mcp__crew__message_user',
        input: { text: 'The implementation agent failed.' },
      });
      return {
        status: 'failed',
        transcript: [],
        error: 'decision subprocess exited 1',
      };
    });
    const session = CaptainSession.create({ projectRoot });
    session.appendUserMessage('status?');
    const dispatcher = new ToolDispatcher();
    const runner = new JudgmentRunner(
      captain,
      makeRegistry([captain]),
      workflow,
      stateStore,
      worktreeManager,
      { session, dispatcher },
    );

    await expect(runner.run('status?')).rejects.toThrow(
      'Captain adapter failed: decision subprocess exited 1',
    );

    const reloaded = CaptainSession.load({ projectRoot });
    expect(
      reloaded?.getMessages().some(
        (m) => m.role === 'assistant' && m.text === 'The implementation agent failed.',
      ),
    ).toBe(true);
  });

  it('flags providerSessionRejected when the adapter returns a session-id error (M3-10a regex plumbing)', async () => {
    // Regression for review Finding 7: the regex /session id|invalid session|rejected/i
    // in the M3 captain-turn converts a failed executeWithTools result into
    // providerSessionRejected=true, which drives the one-shot replay (N9).
    // Any tightening of that regex must fail this test.
    const captainSessionErrorVariants = [
      'The session id was not recognized by the CLI',
      'invalid session identifier; please resubmit',
      'session rejected upstream',
    ];
    for (const errorText of captainSessionErrorVariants) {
      const captain = makeCaptain(async () => ({
        status: 'failed',
        transcript: [],
        error: errorText,
      }));
      const session = CaptainSession.create({ projectRoot });
      session.appendUserMessage(`trigger: ${errorText}`);
      // Seed a non-undefined providerSessionRef BEFORE the run — this is
      // the load-bearing part of the assertion. If the regex fails to
      // match, the session-loop's replay path never fires, the ref
      // survives, and our post-run assertion catches it. Without this
      // sentinel the ref would be `undefined` both before and after
      // regardless of regex behavior (review Finding 7 follow-up).
      session.providerSessionRef = `sentinel-ref-${errorText.length}`;
      const dispatcher = new ToolDispatcher();
      const runner = new JudgmentRunner(
        captain,
        makeRegistry([captain]),
        workflow,
        stateStore,
        worktreeManager,
        { session, dispatcher },
      );
      // Because the adapter ALWAYS returns session-rejected, the replay
      // also fails; the loop throws per N9 (two consecutive rejections).
      // We catch that to isolate the assertion on replay-detection plumbing.
      await runner.run(`trigger: ${errorText}`).catch(() => undefined);
      // The regex correctly detected session-rejection on the first turn
      // → session-loop cleared the sentinel ref during replay. If the
      // regex tightens and misses any variant, the ref survives.
      expect(session.providerSessionRef).toBeUndefined();
    }
  });

});
