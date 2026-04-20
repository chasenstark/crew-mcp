import { describe, expect, it } from 'vitest';
import {
  ToolCatalog,
  M3_TOOL_NAMES,
  promptAgentInventoryFromRegistry,
} from '../../../src/captain/tools/catalog.js';
import { CaptainActionServer, DEFAULT_TOOL_NAMESPACE } from '../../../src/captain/action-server.js';
import { createRegistryFromConfig } from '../../../src/adapters/registry.js';
import type { WorkflowConfig } from '../../../src/workflow/types.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

function registry() {
  return createRegistryFromConfig({
    'claude-code': { adapter: 'claude-code' },
    codex: { adapter: 'codex' },
  });
}

describe('ToolCatalog.toActionCatalog', () => {
  it('returns exactly the 8 M3 tool entries in a stable order', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const entries = catalog.toActionCatalog();
    expect(entries).toHaveLength(8);
    expect(entries.map((e) => e.name)).toEqual([...M3_TOOL_NAMES]);
  });

  it('each entry has a description and an input schema', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    for (const entry of catalog.toActionCatalog()) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.inputSchema).toBeDefined();
      expect(typeof (entry.inputSchema as { parse: unknown }).parse).toBe('function');
    }
  });

  it('tags run_agent as Primary and the three wrapper tools as Optional (M4-3)', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const by = Object.fromEntries(
      catalog.toActionCatalog().map((e) => [e.name, e]),
    );
    expect(by.run_agent.description).toMatch(/^\*\*Primary work primitive\.\*\*/);
    expect(by.plan_tasks.description).toMatch(/^\*\*Optional\.\*\*/);
    expect(by.analyze_output.description).toMatch(/^\*\*Optional\.\*\*/);
    expect(by.compress_context.description).toMatch(/^\*\*Optional\.\*\*/);
    // No other tool carries a Primary/Optional tag — those four are the
    // full set M4-3 marks.
    const tagged = Object.values(by).filter((e) =>
      /^\*\*(Primary|Optional)/.test(e.description),
    );
    expect(tagged.map((e) => e.name).sort()).toEqual(
      ['analyze_output', 'compress_context', 'plan_tasks', 'run_agent'].sort(),
    );
  });

  it('finish tells the captain to end as soon as the request is addressed (M4-3)', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const finish = catalog.toActionCatalog().find((e) => e.name === 'finish')!;
    expect(finish.description).toContain(
      'Call this as soon as the user\'s request is addressed',
    );
    expect(finish.description).toContain('Do NOT wait');
  });

  it('run_agent schema requires agent_id + prompt', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const runAgent = catalog
      .toActionCatalog()
      .find((e) => e.name === 'run_agent')!;
    expect(() => runAgent.inputSchema.parse({})).toThrow();
    expect(() =>
      runAgent.inputSchema.parse({ agent_id: 'codex', prompt: 'fix the typo' }),
    ).not.toThrow();
  });

  it('list_agents schema accepts empty input and arbitrary extras', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const list = catalog
      .toActionCatalog()
      .find((e) => e.name === 'list_agents')!;
    expect(() => list.inputSchema.parse({})).not.toThrow();
    expect(() => list.inputSchema.parse({ refresh: true })).not.toThrow();
  });

  it('ask_user + message_user + finish require a non-empty string field', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const by = Object.fromEntries(
      catalog.toActionCatalog().map((e) => [e.name, e]),
    );
    expect(() => by.ask_user.inputSchema.parse({ question: '' })).toThrow();
    expect(() =>
      by.ask_user.inputSchema.parse({ question: 'what?' }),
    ).not.toThrow();
    expect(() => by.message_user.inputSchema.parse({ text: '' })).toThrow();
    expect(() => by.finish.inputSchema.parse({ summary: '' })).toThrow();
  });

  it('accepts optional wrapper-omission mode', () => {
    const catalog = new ToolCatalog({
      registry: registry(),
      workflow,
      omitOptionalWrappers: true,
    });
    const names = catalog.toActionCatalog().map((e) => e.name);
    expect(names).not.toContain('plan_tasks');
    expect(names).not.toContain('analyze_output');
    expect(names).not.toContain('compress_context');
    expect(names).toContain('run_agent');
    expect(names).toContain('finish');
  });
});

describe('ToolCatalog + CaptainActionServer integration', () => {
  it('produces the namespaced mcp__crew__ tools via buildActionServer', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const server = catalog.buildActionServer();
    const names = server.listTools().map((t) => t.name);
    expect(names.every((n) => n.startsWith(DEFAULT_TOOL_NAMESPACE))).toBe(true);
    expect(names).toContain(`${DEFAULT_TOOL_NAMESPACE}run_agent`);
    expect(names).toContain(`${DEFAULT_TOOL_NAMESPACE}finish`);
  });

  it('cached action server returns the same reference across calls', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const a = catalog.buildActionServer();
    const b = catalog.buildActionServer();
    expect(a).toBe(b);
  });

  it('getToolSchemaHash is stable across two catalogs with the same surface', () => {
    const a = new ToolCatalog({ registry: registry(), workflow });
    const b = new ToolCatalog({ registry: registry(), workflow });
    expect(a.getToolSchemaHash()).toBe(b.getToolSchemaHash());
  });

  it('getToolSchemaHash is stable even when the registry content differs (prompt material, not tool spec)', () => {
    const a = new ToolCatalog({ registry: registry(), workflow });
    const b = new ToolCatalog({
      registry: createRegistryFromConfig({
        'claude-code': { adapter: 'claude-code' },
        codex: { adapter: 'codex' },
        'gemini-cli': { adapter: 'gemini-cli' },
      }),
      workflow,
    });
    // Adding a third agent should NOT invalidate providerSessionRef because
    // list_agents reads live state at call time; the tool spec is unchanged.
    expect(a.getToolSchemaHash()).toBe(b.getToolSchemaHash());
  });

  it('getToolSchemaHash is independent of prompt-material inputs entirely (M5-6 catalog decoupling)', async () => {
    // M5-6 removed `preset` from `ToolCatalogInit` — prompt-material inputs
    // no longer flow through the catalog at all. The invariant is stronger
    // than the pre-M5 "preset hint changes don't leak into hash" test: the
    // catalog input surface has no prompt-material fields, so rendering two
    // different resolved presets through `buildCaptainSystemPrompt` outside
    // the catalog produces distinct prompts from an identical catalog, and
    // the catalog's hash is trivially equal.
    const a = new ToolCatalog({ registry: registry(), workflow });
    const b = new ToolCatalog({ registry: registry(), workflow });
    expect(a.getToolSchemaHash()).toBe(b.getToolSchemaHash());

    // And confirm different preset values rendered OUTSIDE the catalog
    // change the prompt body without touching the hash.
    const { buildCaptainSystemPrompt } = await import('../../../src/captain/prompts/captain-system.js');
    const promptOld = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'codex', capabilities: ['implement'] }],
      tools: a.toActionCatalog().map((e) => ({ name: e.name, description: e.description })),
      preset: { name: 'x', hint: 'old hint' },
    });
    const promptNew = buildCaptainSystemPrompt({
      workflow,
      agents: [{ name: 'codex', capabilities: ['implement'] }],
      tools: a.toActionCatalog().map((e) => ({ name: e.name, description: e.description })),
      preset: { name: 'x', hint: 'new hint' },
    });
    expect(promptOld).not.toBe(promptNew);
    // Hash is unchanged by prompt-body shifts.
    expect(a.getToolSchemaHash()).toBe(b.getToolSchemaHash());
  });

  it('getToolSchemaHash changes when the tool surface changes', () => {
    const full = new ToolCatalog({ registry: registry(), workflow });
    const slim = new ToolCatalog({
      registry: registry(),
      workflow,
      omitOptionalWrappers: true,
    });
    expect(full.getToolSchemaHash()).not.toBe(slim.getToolSchemaHash());
  });
});

describe('ToolCatalog projections', () => {
  it('toMcpServers returns the deterministic single "crew" entry', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const servers = catalog.toMcpServers();
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('crew');
    expect(servers[0].command).toBe('crew-mcp');
  });

  it('toPromptAgentInventory reflects the registry state verbatim', () => {
    const catalog = new ToolCatalog({
      registry: createRegistryFromConfig({
        codex: { adapter: 'codex' },
        custom: {
          adapter: 'generic',
          command: 'my-tool',
          capabilities: ['typescript', 'devops'],
        },
      }),
      workflow,
    });
    const inventory = catalog.toPromptAgentInventory();
    const byName = Object.fromEntries(inventory.map((e) => [e.name, e]));
    expect(byName.codex).toBeDefined();
    expect(byName.custom?.capabilities).toEqual(['typescript', 'devops']);
  });

  it('toMcpRegistrationCatalog feeds converters with both mcpServers and crewTools', () => {
    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const out = catalog.toMcpRegistrationCatalog();
    expect(out.mcpServers[0].name).toBe('crew');
    expect(out.crewTools.length).toBe(8);
    expect(out.crewTools.every((t) => t.name.startsWith(DEFAULT_TOOL_NAMESPACE))).toBe(true);
  });
});

describe('promptAgentInventoryFromRegistry helper', () => {
  it('is equivalent to catalog.toPromptAgentInventory for the same registry', () => {
    const r = registry();
    const catalog = new ToolCatalog({ registry: r, workflow });
    expect(promptAgentInventoryFromRegistry(r)).toEqual(catalog.toPromptAgentInventory());
  });
});

describe('catalog schema + description parity with per-tool files', () => {
  it('each catalog entry references the per-tool schema object by identity (not a copy)', async () => {
    const { runAgentInputSchema, RUN_AGENT_DESCRIPTION } = await import('../../../src/captain/tools/run-agent.js');
    const { listAgentsInputSchema, LIST_AGENTS_DESCRIPTION } = await import('../../../src/captain/tools/list-agents.js');
    const { askUserInputSchema, ASK_USER_DESCRIPTION } = await import('../../../src/captain/tools/ask-user.js');
    const { messageUserInputSchema, MESSAGE_USER_DESCRIPTION } = await import('../../../src/captain/tools/message-user.js');
    const { planTasksInputSchema, PLAN_TASKS_DESCRIPTION } = await import('../../../src/captain/tools/plan-tasks.js');
    const { analyzeOutputInputSchema, ANALYZE_OUTPUT_DESCRIPTION } = await import('../../../src/captain/tools/analyze-output.js');
    const { compressContextInputSchema, COMPRESS_CONTEXT_DESCRIPTION } = await import('../../../src/captain/tools/compress-context.js');
    const { finishInputSchema, FINISH_DESCRIPTION } = await import('../../../src/captain/tools/finish.js');

    const catalog = new ToolCatalog({ registry: registry(), workflow });
    const by = Object.fromEntries(
      catalog.toActionCatalog().map((e) => [e.name, e]),
    );

    // Identity check prevents schema drift — if catalog.ts ever re-declares
    // a schema rather than re-exporting, this test fails.
    expect(by.run_agent.inputSchema).toBe(runAgentInputSchema);
    expect(by.run_agent.description).toBe(RUN_AGENT_DESCRIPTION);
    expect(by.list_agents.inputSchema).toBe(listAgentsInputSchema);
    expect(by.list_agents.description).toBe(LIST_AGENTS_DESCRIPTION);
    expect(by.ask_user.inputSchema).toBe(askUserInputSchema);
    expect(by.ask_user.description).toBe(ASK_USER_DESCRIPTION);
    expect(by.message_user.inputSchema).toBe(messageUserInputSchema);
    expect(by.message_user.description).toBe(MESSAGE_USER_DESCRIPTION);
    expect(by.plan_tasks.inputSchema).toBe(planTasksInputSchema);
    expect(by.plan_tasks.description).toBe(PLAN_TASKS_DESCRIPTION);
    expect(by.analyze_output.inputSchema).toBe(analyzeOutputInputSchema);
    expect(by.analyze_output.description).toBe(ANALYZE_OUTPUT_DESCRIPTION);
    expect(by.compress_context.inputSchema).toBe(compressContextInputSchema);
    expect(by.compress_context.description).toBe(COMPRESS_CONTEXT_DESCRIPTION);
    expect(by.finish.inputSchema).toBe(finishInputSchema);
    expect(by.finish.description).toBe(FINISH_DESCRIPTION);
  });
});
