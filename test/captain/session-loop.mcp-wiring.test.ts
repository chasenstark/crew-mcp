/**
 * Integration test for the session-loop MCP wiring: one ToolCatalog feeds
 * three captain-specific payload shapes via `resolveCaptainConverter`. M3-8
 * locks the pair (catalog, adapter.name) → (payload shape, adapter argv).
 */

import { describe, expect, it } from 'vitest';
import {
  resolveCaptainConverter,
  toClaudeMcpConfigJson,
  toGeminiMcpSettings,
  toCodexConfigOverrides,
  type ToolCatalog,
} from '../../src/captain/mcp-registration.js';
import { ToolCatalog as ToolCatalogClass } from '../../src/captain/tools/catalog.js';
import { createRegistryFromConfig } from '../../src/adapters/registry.js';
import type { WorkflowConfig } from '../../src/workflow/types.js';

const workflow: WorkflowConfig = {
  name: 'default',
  execution: { mode: 'judgment' },
  steps: [],
  completion: { strategy: 'judge_approval', fallback: 'max_passes' },
};

describe('session-loop mcp wiring (M3-8)', () => {
  it('one ToolCatalogClass instance feeds all three converters with (currently empty) MCP-server registrations via resolveCaptainConverter', () => {
    // The M3 `crew-mcp` placeholder was removed — no such binary existed
    // and codex would hang trying to spawn it. Tool routing flows through
    // the JSON envelope in each adapter, not the MCP protocol. This test
    // locks the converter wiring (catalog → per-captain payload shape)
    // while asserting the now-empty registration surface.
    const catalog = new ToolCatalogClass({
      registry: createRegistryFromConfig({
        codex: { adapter: 'codex' },
      }),
      workflow,
    });
    const mcpCatalog = catalog.toMcpRegistrationCatalog();

    // Claude: empty `{}` inline config.
    const claude = resolveCaptainConverter('claude-code', mcpCatalog);
    expect(claude?.kind).toBe('claude-code');
    if (claude?.kind === 'claude-code') {
      const parsed = JSON.parse(claude.inlineConfigJson);
      expect(parsed).toEqual({});
    }

    // Gemini: empty allowed-server list.
    const gemini = resolveCaptainConverter('gemini-cli', mcpCatalog);
    expect(gemini?.kind).toBe('gemini-cli');
    if (gemini?.kind === 'gemini-cli') {
      expect(gemini.allowedServerNames).toEqual([]);
    }

    // Codex: no `-c mcp_servers.*` argv fragments.
    const codex = resolveCaptainConverter('codex', mcpCatalog);
    expect(codex?.kind).toBe('codex');
    if (codex?.kind === 'codex') {
      expect(
        codex.configOverrideArgv.some((a) => a.startsWith('mcp_servers.')),
      ).toBe(false);
    }
  });

  it('removing a server from the catalog drops it from all three payloads', () => {
    const fat: ToolCatalog = {
      mcpServers: [
        { name: 'crew', command: 'crew-mcp' },
        { name: 'extra', command: '/bin/e' },
      ],
    };
    const thin: ToolCatalog = {
      mcpServers: [{ name: 'crew', command: 'crew-mcp' }],
    };

    const fatClaude = JSON.parse(toClaudeMcpConfigJson(fat));
    const thinClaude = JSON.parse(toClaudeMcpConfigJson(thin));
    expect(fatClaude.mcpServers.extra).toBeDefined();
    expect(thinClaude.mcpServers.extra).toBeUndefined();

    expect(toGeminiMcpSettings(fat).allowedServerNames).toContain('extra');
    expect(toGeminiMcpSettings(thin).allowedServerNames).not.toContain('extra');

    const fatCodex = toCodexConfigOverrides(fat);
    const thinCodex = toCodexConfigOverrides(thin);
    expect(fatCodex.some((a) => a.includes('extra'))).toBe(true);
    expect(thinCodex.some((a) => a.includes('extra'))).toBe(false);
  });

  it('non-MCP-aware captain adapters get undefined (generic, openai-compatible)', () => {
    const catalog: ToolCatalog = { mcpServers: [{ name: 'crew', command: 'crew-mcp' }] };
    expect(resolveCaptainConverter('generic', catalog)).toBeUndefined();
    expect(resolveCaptainConverter('openai-compatible', catalog)).toBeUndefined();
    expect(resolveCaptainConverter('unknown-cli', catalog)).toBeUndefined();
  });
});
